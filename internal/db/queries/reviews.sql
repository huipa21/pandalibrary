-- name: ReviewList :many
SELECT r.*, CAST(COALESCE(NULLIF(u.display_name, ''), u.username) AS TEXT) AS display_name
FROM book_reviews r JOIN users u ON u.id = r.user_id
WHERE r.book_id = sqlc.arg(book_id) AND r.user_id != sqlc.arg(viewer_id)
  AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0 OR (r.updated_at, r.id) < (sqlc.arg(after_time), sqlc.arg(after_id)))
ORDER BY r.updated_at DESC, r.id DESC
LIMIT sqlc.arg(page_size);

-- name: ReviewMine :one
SELECT r.*, CAST(COALESCE(NULLIF(u.display_name, ''), u.username) AS TEXT) AS display_name
FROM book_reviews r JOIN users u ON u.id = r.user_id
WHERE r.book_id = ? AND r.user_id = ?;

-- name: ReviewSave :exec
INSERT INTO book_reviews (book_id, user_id, body, created_at, updated_at)
VALUES (sqlc.arg(book_id), sqlc.arg(user_id), sqlc.arg(body), sqlc.arg(now), sqlc.arg(now))
ON CONFLICT (book_id, user_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at;

-- name: ReviewDeleteMine :execrows
DELETE FROM book_reviews WHERE book_id = ? AND user_id = ?;

-- name: ReviewDelete :execrows
DELETE FROM book_reviews WHERE book_id = ? AND id = ?;

-- name: ReviewCount :one
SELECT count(*) FROM book_reviews WHERE book_id = ?;
