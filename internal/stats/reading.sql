WITH visible_books AS (
    SELECT b.id, b.title FROM books b
    WHERE @user_id > 0
      AND (b.visibility = 'public' OR b.owner_id = @user_id
           OR (b.visibility = 'library' AND (@is_admin = 1 OR EXISTS (
               SELECT 1 FROM library_access la
               WHERE la.library_id = b.library_id AND la.user_id = @user_id
           ))))
      AND NOT EXISTS (
          SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = @user_id
      )
), sessions AS (
    -- Preserve StatsDaily's whole-session attribution to its local start day.
    SELECT CAST(json_extract(d.value, '$.date') AS TEXT) AS date,
           CAST(strftime('%H', (rs.started_at + json_extract(z.value, '$.offset')) / 1000.0, 'unixepoch') AS INTEGER) AS hour,
           rs.book_id, rs.active_seconds
    FROM json_each(@days) d
    CROSS JOIN reading_sessions rs ON rs.user_id = @user_id
        AND rs.started_at >= json_extract(d.value, '$.start')
        AND rs.started_at < json_extract(d.value, '$.end')
    JOIN visible_books b ON b.id = rs.book_id
    JOIN json_each(@zones) z ON rs.started_at >= json_extract(z.value, '$.start')
        AND rs.started_at < json_extract(z.value, '$.end')
), buckets AS (
    SELECT date, hour, SUM(active_seconds) AS active_seconds, COUNT(*) AS session_count
    FROM sessions GROUP BY date, hour
), finished_events AS (
    SELECT rc.book_id, rc.started_at, rc.ended_at
    FROM reading_cycles rc JOIN visible_books b ON b.id = rc.book_id
    WHERE rc.user_id = @user_id AND rc.status = 'finished'
      AND rc.ended_at >= @start AND rc.ended_at < @end
    UNION ALL
    SELECT ub.book_id, ub.started_at, COALESCE(ub.finished_at, ub.updated_at)
    FROM user_books ub JOIN visible_books b ON b.id = ub.book_id
    WHERE ub.user_id = @user_id AND ub.status = 'finished'
      AND COALESCE(ub.finished_at, ub.updated_at) >= @start
      AND COALESCE(ub.finished_at, ub.updated_at) < @end
), read_books AS (
    SELECT DISTINCT book_id FROM finished_events
), reading_books AS (
    SELECT book_id FROM read_books
    UNION
    SELECT s.book_id FROM sessions s JOIN user_books ub ON ub.book_id = s.book_id
    WHERE ub.user_id = @user_id AND ub.status IN ('finished', 'reading')
), valid_completions AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY book_id ORDER BY ended_at DESC, started_at DESC
    ) AS position
    FROM finished_events
    WHERE started_at IS NOT NULL AND started_at <= ended_at
      AND started_at >= @minimum_start
), latest AS (
    SELECT v.book_id, b.title, v.started_at, v.ended_at
    FROM valid_completions v JOIN visible_books b ON b.id = v.book_id
    WHERE v.position = 1 ORDER BY v.book_id LIMIT @result_limit
), completion_sessions AS (
    SELECT rs.*, l.ended_at AS completed_at
    FROM latest l JOIN reading_sessions rs ON rs.book_id = l.book_id
      AND rs.user_id = @user_id AND rs.started_at >= l.started_at
      AND rs.started_at <= l.ended_at
), progress AS (
    SELECT book_id, seq, 0 AS phase, started_at AS recorded_at, start_percentage AS percentage
    FROM completion_sessions WHERE start_percentage IS NOT NULL
    UNION ALL
    SELECT book_id, seq, 1, ended_at, end_percentage
    FROM completion_sessions WHERE end_percentage IS NOT NULL AND ended_at <= completed_at
)
SELECT
    (SELECT json_group_array(json_object(
        'date', date, 'hour', hour, 'active_seconds', active_seconds, 'session_count', session_count
    )) FROM buckets),
    (SELECT COUNT(*) FROM read_books),
    (SELECT COUNT(*) FROM reading_books),
    (SELECT json_group_array(json_object(
        'book_id', l.book_id, 'title', l.title, 'started_at', l.started_at, 'ended_at', l.ended_at,
        'first_session_at', (SELECT MIN(started_at) FROM completion_sessions s WHERE s.book_id = l.book_id),
        'progress', json((SELECT json_group_array(json_object(
            'recorded_at', recorded_at, 'percentage', percentage
        )) FROM (
            SELECT recorded_at, percentage FROM progress p WHERE p.book_id = l.book_id
            ORDER BY recorded_at, seq, phase
        )))
    )) FROM latest l);
