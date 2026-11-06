-- BH2 assignment queries. Only these statements move rows into or out of the
-- 'queued' and 'importing' statuses.

-- name: BookheapAssignQueue :execrows
UPDATE bookheap_items SET status = 'queued', error = NULL, duplicate_of_book_id = NULL,
    duplicate_of_item_id = NULL, target_library_id = sqlc.arg(target_library_id),
    target_shelf_ids = sqlc.arg(target_shelf_ids), import_job_id = sqlc.arg(import_job_id),
    updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id) AND status IN ('ready', 'failed')
  AND size_bytes = sqlc.arg(size_bytes) AND mtime_ns = sqlc.arg(mtime_ns);

-- name: BookheapAssignMarkChanged :exec
UPDATE bookheap_items SET error = sqlc.arg(error), updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id) AND status IN ('ready', 'failed');

-- name: BookheapAssignStarted :execrows
UPDATE bookheap_items SET status = 'importing', updated_at = sqlc.arg(updated_at)
WHERE import_job_id = sqlc.arg(import_job_id) AND status IN ('queued', 'importing');

-- name: BookheapAssignByJob :one
SELECT * FROM bookheap_items
WHERE import_job_id = sqlc.arg(import_job_id) AND status IN ('queued', 'importing');

-- name: BookheapAssignDeleteImported :execrows
DELETE FROM bookheap_items
WHERE import_job_id = sqlc.arg(import_job_id) AND status IN ('queued', 'importing');

-- name: BookheapAssignFinish :execrows
UPDATE bookheap_items SET status = sqlc.arg(status), error = sqlc.arg(error),
    duplicate_of_book_id = sqlc.arg(duplicate_of_book_id), updated_at = sqlc.arg(updated_at)
WHERE import_job_id = sqlc.arg(import_job_id) AND status IN ('queued', 'importing');

-- name: BookheapAssignResolve :execrows
UPDATE bookheap_items SET status = sqlc.arg(status), error = sqlc.arg(error),
    duplicate_of_book_id = sqlc.arg(duplicate_of_book_id), updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id) AND status IN ('queued', 'importing');

-- name: BookheapAssignBusy :many
SELECT h.id, h.import_job_id, j.status AS job_status, j.error AS job_error,
    j.book_id AS job_book_id, j.duplicate_of_book_id AS job_duplicate_of_book_id
FROM bookheap_items h
LEFT JOIN import_jobs j ON j.id = h.import_job_id
WHERE h.status IN ('queued', 'importing')
ORDER BY h.id;

-- name: BookheapAssignDeleteIdlePath :execrows
DELETE FROM bookheap_items WHERE rel_path = ? AND status NOT IN ('queued', 'importing');

-- name: BookheapAssignUser :one
SELECT role, disabled FROM users WHERE id = ?;
