-- +goose Up
CREATE TEMP TABLE status_lifecycle AS
SELECT rp.user_id, rp.book_id,
       CASE WHEN rp.percentage >= 0.99 THEN 'finished' ELSE 'reading' END AS new_status,
       rp.updated_at AS progress_updated_at,
       (SELECT value FROM sync_counter WHERE id = 1)
           + row_number() OVER (ORDER BY rp.user_id, rp.book_id) AS rev
FROM reading_progress rp
LEFT JOIN user_books ub ON ub.user_id = rp.user_id AND ub.book_id = rp.book_id
WHERE (rp.percentage > 0 AND (ub.status IS NULL OR ub.status IN ('unread', 'want_to_read')))
   OR (rp.percentage >= 0.99 AND ub.status IN ('reading', 'rereading'));

INSERT INTO user_books (user_id, book_id, status, started_at, finished_at, updated_at, rev)
SELECT user_id, book_id, new_status, progress_updated_at,
       CASE WHEN new_status = 'finished' THEN progress_updated_at END,
       progress_updated_at + 1, rev
FROM status_lifecycle
WHERE true
ON CONFLICT (user_id, book_id) DO UPDATE SET
    status = excluded.status,
    started_at = COALESCE(user_books.started_at, excluded.started_at),
    finished_at = CASE WHEN excluded.status = 'finished'
        THEN COALESCE(user_books.finished_at, excluded.finished_at) ELSE user_books.finished_at END,
    updated_at = MAX(user_books.updated_at, excluded.updated_at - 1) + 1,
    rev = excluded.rev;

UPDATE sync_counter SET value = value + (SELECT count(*) FROM status_lifecycle) WHERE id = 1;
DROP TABLE status_lifecycle;

-- +goose Down
-- Statuses are user data and remain valid on the previous schema.
SELECT 1;
