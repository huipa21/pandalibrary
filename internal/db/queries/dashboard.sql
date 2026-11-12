-- name: DashboardContinueReadingBooks :many
SELECT b.id, CAST(COALESCE(rp.updated_at, ub.updated_at) AS INTEGER) AS sort_time FROM books b
LEFT JOIN reading_progress rp ON rp.book_id = b.id AND rp.user_id = sqlc.arg(user_id)
LEFT JOIN user_books ub ON ub.book_id = b.id AND ub.user_id = sqlc.arg(user_id)
WHERE ((rp.percentage > 0 AND rp.percentage < 1) OR ub.status IN ('reading', 'rereading', 'on_hold'))
AND (ub.status IS NULL OR ub.status NOT IN ('finished', 'skimmed', 'abandoned'))
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR COALESCE(rp.updated_at, ub.updated_at) < CAST(sqlc.arg(after_time) AS INTEGER)
    OR (COALESCE(rp.updated_at, ub.updated_at) = CAST(sqlc.arg(after_time) AS INTEGER) AND b.id < sqlc.arg(after_id)))
ORDER BY COALESCE(rp.updated_at, ub.updated_at) DESC, b.id DESC
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: DashboardRecentlyAddedBooks :many
SELECT b.id, b.created_at AS sort_time FROM books b
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR b.created_at < CAST(sqlc.arg(after_time) AS INTEGER)
    OR (b.created_at = CAST(sqlc.arg(after_time) AS INTEGER) AND b.id < sqlc.arg(after_id)))
ORDER BY b.created_at DESC, b.id DESC
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: DashboardReadBooks :many
WITH completed_cycles AS (
    SELECT book_id, ended_at FROM reading_cycles
    WHERE user_id = sqlc.arg(user_id) AND status IN ('finished', 'skimmed')
    UNION ALL
    SELECT book_id, COALESCE(finished_at, updated_at) AS ended_at FROM user_books
    WHERE user_id = sqlc.arg(user_id) AND status IN ('finished', 'skimmed')
), completed_books AS (
    SELECT book_id, MAX(ended_at) AS ended_at FROM completed_cycles GROUP BY book_id
)
SELECT b.id, CAST(c.ended_at AS INTEGER) AS sort_time FROM books b
JOIN completed_books c ON c.book_id = b.id
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR c.ended_at < CAST(sqlc.arg(after_time) AS INTEGER)
    OR (c.ended_at = CAST(sqlc.arg(after_time) AS INTEGER) AND b.id < sqlc.arg(after_id)))
ORDER BY c.ended_at DESC, b.id DESC
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: DashboardUnreadBooks :many
SELECT b.id, b.title AS sort_title FROM books b
LEFT JOIN user_books ub ON ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id
WHERE (ub.user_id IS NULL OR ub.status = 'unread')
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR b.title COLLATE NOCASE > CAST(sqlc.arg(after_title) AS TEXT) COLLATE NOCASE
    OR (b.title COLLATE NOCASE = CAST(sqlc.arg(after_title) AS TEXT) COLLATE NOCASE
        AND b.id > sqlc.arg(after_id)))
ORDER BY b.title COLLATE NOCASE, b.id ASC
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: DashboardWantToReadBooks :many
SELECT b.id, ub.updated_at AS sort_time FROM books b
JOIN user_books ub ON ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id AND ub.status = 'want_to_read'
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR ub.updated_at < CAST(sqlc.arg(after_time) AS INTEGER)
    OR (ub.updated_at = CAST(sqlc.arg(after_time) AS INTEGER) AND b.id < sqlc.arg(after_id)))
ORDER BY ub.updated_at DESC, b.id DESC
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);
