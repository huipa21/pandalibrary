-- name: ReadingLatestCycleEnd :one
SELECT CAST(COALESCE(MAX(ended_at), -1) AS INTEGER) AS ended_at
FROM reading_cycles
WHERE user_id = sqlc.arg(user_id) AND book_id = sqlc.arg(book_id);

-- name: ReadingAdvanceCycle :exec
UPDATE user_books SET reading_cycle = reading_cycle + 1
WHERE user_id = sqlc.arg(user_id) AND book_id = sqlc.arg(book_id);

-- name: ReadingCycleEndExists :one
SELECT CAST(EXISTS (
    SELECT 1 FROM reading_cycles
    WHERE user_id = sqlc.arg(user_id) AND book_id = sqlc.arg(book_id)
      AND ended_at = sqlc.arg(ended_at)
) AS INTEGER);

-- name: ReadingArchiveCycle :exec
INSERT INTO reading_cycles (user_id, book_id, started_at, ended_at, status, percentage)
VALUES (sqlc.arg(user_id), sqlc.arg(book_id), sqlc.arg(started_at), sqlc.arg(ended_at),
        sqlc.arg(status), sqlc.arg(percentage));

-- name: ReadingSetLifecycleProgress :exec
INSERT INTO reading_progress (user_id, book_id, source, percentage, updated_at, rev)
VALUES (sqlc.arg(user_id), sqlc.arg(book_id), 'web', sqlc.arg(percentage), sqlc.arg(updated_at), sqlc.arg(rev))
ON CONFLICT (user_id, book_id) DO UPDATE SET
    percentage = excluded.percentage,
    locator = CASE WHEN excluded.percentage = 0 THEN NULL ELSE reading_progress.locator END,
    updated_at = excluded.updated_at,
    rev = excluded.rev;
