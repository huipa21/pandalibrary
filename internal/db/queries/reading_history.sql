-- name: ReadingListCycles :many
SELECT started_at, ended_at, status, percentage
FROM reading_cycles
WHERE user_id = sqlc.arg(user_id) AND book_id = sqlc.arg(book_id)
ORDER BY id;
