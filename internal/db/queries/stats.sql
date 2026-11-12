-- name: StatsDaily :many
SELECT CAST(json_extract(d.value, '$.date') AS TEXT) AS date,
       CAST(SUM(rs.active_seconds) AS INTEGER) AS active_seconds,
       COUNT(*) AS session_count
FROM json_each(CAST(sqlc.arg(days) AS TEXT)) d
CROSS JOIN reading_sessions rs ON rs.user_id = sqlc.arg(user_id)
    AND rs.started_at >= CAST(json_extract(d.value, '$.start') AS INTEGER)
    AND rs.started_at < CAST(json_extract(d.value, '$.end') AS INTEGER)
JOIN books b ON b.id = rs.book_id
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
GROUP BY date ORDER BY date;

-- name: StatsFinishedDays :many
WITH terminal_cycles AS (
    SELECT book_id, ended_at FROM reading_cycles WHERE user_id = sqlc.arg(user_id)
    UNION ALL
    SELECT book_id, COALESCE(finished_at, updated_at) AS ended_at
    FROM user_books WHERE user_id = sqlc.arg(user_id) AND status IN ('finished', 'skimmed', 'abandoned')
)
SELECT CAST(json_extract(d.value, '$.date') AS TEXT) AS date, COUNT(*) AS books_finished
FROM terminal_cycles
JOIN books b ON b.id = terminal_cycles.book_id
CROSS JOIN json_each(CAST(sqlc.arg(days) AS TEXT)) d
WHERE terminal_cycles.ended_at >= CAST(json_extract(d.value, '$.start') AS INTEGER)
AND terminal_cycles.ended_at < CAST(json_extract(d.value, '$.end') AS INTEGER)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
GROUP BY date ORDER BY date;

-- name: StatsTimePerBook :many
SELECT b.id AS book_id, b.title,
       CAST((SELECT json_group_array(name) FROM (
           SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
           WHERE ba.book_id = b.id AND ba.role = 'author'
           ORDER BY ba.position, a.id
       )) AS TEXT) AS authors,
       CAST(SUM(rs.active_seconds) AS INTEGER) AS active_seconds,
       COUNT(*) AS session_count
FROM reading_sessions rs JOIN books b ON b.id = rs.book_id
WHERE rs.user_id = sqlc.arg(user_id)
AND rs.started_at >= sqlc.arg(start_at) AND rs.started_at < sqlc.arg(end_at)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
GROUP BY b.id
ORDER BY active_seconds DESC, b.id
LIMIT sqlc.arg(result_limit);

-- name: StatsHistoryBounds :one
SELECT CAST(COALESCE(MIN(rs.started_at), sqlc.arg(end_at)) AS INTEGER) AS start_at,
       CAST(COALESCE(MAX(rs.started_at) + 1, sqlc.arg(end_at)) AS INTEGER) AS end_at
FROM reading_sessions rs JOIN books b ON b.id = rs.book_id
WHERE rs.user_id = sqlc.arg(user_id) AND rs.started_at < sqlc.arg(end_at)
AND rs.active_seconds > 0
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- The service supplies bounded IANA offset intervals, not individual sessions.
-- Integer division is adjusted to floor for local dates before the Unix epoch.
-- The final day's island is to_day minus the total number of active days;
-- if to_day is inactive, that island does not exist.
-- name: StatsStreaks :one
WITH local_days AS (
    SELECT DISTINCT
        (rs.started_at + CAST(json_extract(z.value, '$.offset') AS INTEGER)) / 86400000
        - ((rs.started_at + CAST(json_extract(z.value, '$.offset') AS INTEGER)) % 86400000 < 0) AS day
    FROM json_each(CAST(sqlc.arg(zones) AS TEXT)) z
    CROSS JOIN reading_sessions rs ON rs.user_id = sqlc.arg(user_id)
        AND rs.started_at >= CAST(json_extract(z.value, '$.start') AS INTEGER)
        AND rs.started_at < CAST(json_extract(z.value, '$.end') AS INTEGER)
    JOIN books b ON b.id = rs.book_id
    WHERE rs.active_seconds > 0
    AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
        SELECT 1 FROM library_access la
        WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
    )))))
    AND NOT EXISTS (
        SELECT 1 FROM book_hidden h
        WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
    )
), numbered AS (
    SELECT day, day - ROW_NUMBER() OVER (ORDER BY day) AS island FROM local_days
)
SELECT CAST((SELECT COUNT(*) FROM numbered
             WHERE island = CAST(sqlc.arg(to_day) AS INTEGER) - (SELECT COUNT(*) FROM local_days)) AS INTEGER) AS current_days,
       CAST(COALESCE((SELECT COUNT(*) FROM numbered GROUP BY island
                      ORDER BY COUNT(*) DESC LIMIT 1), 0) AS INTEGER) AS longest_days;
