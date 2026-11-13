-- Sessions belong wholly to the local day on which they started, as in StatsDaily.
-- Only aggregate JSON crosses the database boundary; the page limit is applied
-- after grouping and day totals, independently of all full-year summaries.
WITH visible_sessions AS (
    SELECT CAST(json_extract(d.value, '$.date') AS TEXT) AS date,
           rs.book_id, rs.started_at, rs.active_seconds
    FROM json_each(CAST(@days AS TEXT)) d
    CROSS JOIN reading_sessions rs ON rs.user_id = @user_id
        AND rs.started_at >= CAST(json_extract(d.value, '$.start') AS INTEGER)
        AND rs.started_at < CAST(json_extract(d.value, '$.end') AS INTEGER)
    JOIN books b ON b.id = rs.book_id
    WHERE (b.visibility = 'public' OR b.owner_id = @user_id OR
        (b.visibility = 'library' AND (CAST(@is_admin AS INTEGER) = 1 OR EXISTS (
            SELECT 1 FROM library_access la
            WHERE la.library_id = b.library_id AND la.user_id = @user_id
        ))))
    AND NOT EXISTS (
        SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = @user_id
    )
), cycle_boundaries AS (
    -- Completion alone is not a restart. Keep sessions between a completion
    -- and the following explicit cycle's start in the completed cycle.
    SELECT rc.book_id, rc.ended_at,
           COALESCE(LEAD(rc.started_at) OVER (
               PARTITION BY rc.book_id ORDER BY rc.ended_at
           ), ub.started_at) AS next_start
    FROM reading_cycles rc
    LEFT JOIN user_books ub ON ub.user_id = rc.user_id AND ub.book_id = rc.book_id
    WHERE rc.user_id = @user_id
      AND rc.book_id IN (SELECT book_id FROM visible_sessions)
), cycle_counts AS (
    SELECT book_id, COUNT(*) AS archived FROM cycle_boundaries GROUP BY book_id
), attributed AS (
    SELECT v.*,
        CASE WHEN COALESCE(cc.archived, 0) = 0 THEN
            CASE WHEN ub.reading_cycle > 1 AND v.started_at < ub.started_at
                 THEN ub.reading_cycle - 1 ELSE COALESCE(ub.reading_cycle, 1) END
        -- The counter may predate archived history (legacy rereading = cycle 2).
        ELSE MAX(1, COALESCE(ub.reading_cycle, 1) - cc.archived) + (
            SELECT COUNT(*) FROM cycle_boundaries cb
            WHERE cb.book_id = v.book_id AND cb.ended_at < v.started_at
              AND (cb.next_start IS NULL OR cb.next_start <= v.started_at)
        ) END AS cycle
    FROM visible_sessions v
    LEFT JOIN user_books ub ON ub.user_id = @user_id AND ub.book_id = v.book_id
    LEFT JOIN cycle_counts cc ON cc.book_id = v.book_id
), grouped AS (
    SELECT date, book_id, cycle, SUM(active_seconds) AS active_seconds, COUNT(*) AS session_count,
           MAX(started_at) AS latest,
           SUM(SUM(active_seconds)) OVER (PARTITION BY date) AS day_active_seconds,
           SUM(COUNT(*)) OVER (PARTITION BY date) AS day_session_count
    FROM attributed GROUP BY date, book_id, cycle
), page AS (
    SELECT g.* FROM grouped g
    WHERE CAST(@after_date AS TEXT) = '' OR g.date < @after_date
       OR (g.date = @after_date AND g.latest < @after_latest)
       OR (g.date = @after_date AND g.latest = @after_latest AND g.book_id > @after_book)
       OR (g.date = @after_date AND g.latest = @after_latest AND g.book_id = @after_book AND g.cycle > @after_cycle)
    ORDER BY g.date DESC, g.latest DESC, g.book_id, g.cycle
    LIMIT @result_limit
), daily AS (
    SELECT date, SUM(active_seconds) AS active_seconds, COUNT(*) AS session_count
    FROM visible_sessions GROUP BY date
), monthly AS (
    SELECT SUBSTR(date, 1, 7) AS month, COUNT(DISTINCT book_id) AS books,
           SUM(active_seconds) AS active_seconds, COUNT(*) AS session_count
    FROM visible_sessions GROUP BY month ORDER BY month
), per_book AS (
    SELECT book_id, COUNT(*) AS session_count FROM visible_sessions GROUP BY book_id
)
SELECT CAST((
    SELECT json_group_array(json_object(
        'date', p.date, 'book_id', p.book_id, 'title', b.title, '_latest', p.latest,
        'authors', json((SELECT json_group_array(name) FROM (
            SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
            WHERE ba.book_id = b.id AND ba.role = 'author' ORDER BY ba.position, a.id
        ))),
        'cover_url', CASE WHEN b.cover_sha256 IS NOT NULL THEN '/api/v1/books/' || b.id || '/cover' END,
        'cycle', p.cycle, 'active_seconds', p.active_seconds, 'session_count', p.session_count,
        'day_active_seconds', p.day_active_seconds, 'day_session_count', p.day_session_count
    ) ORDER BY p.date DESC, p.latest DESC, p.book_id, p.cycle)
    FROM page p JOIN books b ON b.id = p.book_id
) AS TEXT) AS items,
CAST(json_object(
    'books', (SELECT COUNT(*) FROM per_book),
    'active_seconds', (SELECT COALESCE(SUM(active_seconds), 0) FROM visible_sessions),
    'session_count', (SELECT COUNT(*) FROM visible_sessions),
    'active_days', (SELECT COUNT(*) FROM daily WHERE active_seconds > 0),
    'months', json((SELECT json_group_array(json_object(
        'month', month, 'books', books, 'active_seconds', active_seconds, 'session_count', session_count
    )) FROM monthly)),
    'records', json_object(
        'busiest_day', json((SELECT json_object(
            'date', date, 'active_seconds', active_seconds, 'session_count', session_count
        ) FROM daily ORDER BY active_seconds DESC, session_count DESC, date DESC LIMIT 1)),
        'longest_session_seconds', (SELECT COALESCE(MAX(active_seconds), 0) FROM visible_sessions),
        'most_read_book', json((SELECT json_object(
            'book_id', pb.book_id, 'title', b.title, 'session_count', pb.session_count
        ) FROM per_book pb JOIN books b ON b.id = pb.book_id
          ORDER BY pb.session_count DESC, pb.book_id LIMIT 1))
    )
) AS TEXT) AS summary;
