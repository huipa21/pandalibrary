-- name: DashboardContinueReadingBooks :many
SELECT b.id FROM books b
JOIN reading_progress rp ON rp.book_id = b.id
WHERE rp.user_id = sqlc.arg(user_id)
AND rp.percentage > 0 AND rp.percentage < 1
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY rp.updated_at DESC, b.id ASC;

-- name: DashboardRecentlyAddedBooks :many
SELECT b.id FROM books b
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY b.created_at DESC, b.id ASC;

-- name: DashboardReadBooks :many
SELECT b.id FROM books b
JOIN user_books ub ON ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id AND ub.status = 'finished'
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY COALESCE(ub.finished_at, ub.updated_at) DESC, b.id ASC;

-- name: DashboardUnreadBooks :many
SELECT b.id FROM books b
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
ORDER BY b.title COLLATE NOCASE, b.id ASC;

-- name: DashboardWantToReadBooks :many
SELECT b.id FROM books b
JOIN user_books ub ON ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id AND ub.status = 'want_to_read'
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY ub.updated_at DESC, b.id ASC;
