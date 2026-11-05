-- name: DashboardContinueReadingBooks :many
SELECT b.id, rp.updated_at AS sort_time FROM books b
JOIN reading_progress rp ON rp.book_id = b.id
WHERE rp.user_id = sqlc.arg(user_id)
AND rp.percentage > 0 AND rp.percentage < 1
AND NOT EXISTS (
    SELECT 1 FROM user_books ub
    WHERE ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id
      AND ub.status IN ('finished', 'abandoned')
)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR rp.updated_at < CAST(sqlc.arg(after_time) AS INTEGER)
    OR (rp.updated_at = CAST(sqlc.arg(after_time) AS INTEGER) AND b.id < sqlc.arg(after_id)))
ORDER BY rp.updated_at DESC, b.id DESC
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: DashboardRecentlyAddedBooks :many
SELECT b.id, b.created_at AS sort_time FROM books b
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
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
SELECT b.id, CAST(COALESCE(ub.finished_at, ub.updated_at) AS INTEGER) AS sort_time FROM books b
JOIN user_books ub ON ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id AND ub.status = 'finished'
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR COALESCE(ub.finished_at, ub.updated_at) < CAST(sqlc.arg(after_time) AS INTEGER)
    OR (COALESCE(ub.finished_at, ub.updated_at) = CAST(sqlc.arg(after_time) AS INTEGER) AND b.id < sqlc.arg(after_id)))
ORDER BY COALESCE(ub.finished_at, ub.updated_at) DESC, b.id DESC
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: DashboardUnreadBooks :many
SELECT b.id, b.title AS sort_title FROM books b
LEFT JOIN user_books ub ON ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id
WHERE (ub.user_id IS NULL OR ub.status = 'unread')
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
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
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR ub.updated_at < CAST(sqlc.arg(after_time) AS INTEGER)
    OR (ub.updated_at = CAST(sqlc.arg(after_time) AS INTEGER) AND b.id < sqlc.arg(after_id)))
ORDER BY ub.updated_at DESC, b.id DESC
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);
