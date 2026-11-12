-- name: BookheapInsert :one
INSERT INTO bookheap_items (rel_path, file_name, size_bytes, mtime_ns, sha256, format, title, authors,
    language, series, series_index, cover_sha256, source, status, error, duplicate_of_book_id,
    duplicate_of_item_id, added_by, created_at, updated_at, visibility)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (rel_path) DO NOTHING
RETURNING *;

-- name: BookheapGet :one
SELECT * FROM bookheap_items WHERE id = ?;

-- name: BookheapByPath :one
SELECT * FROM bookheap_items WHERE rel_path = ?;

-- name: BookheapScanEntries :many
SELECT id, rel_path, size_bytes, mtime_ns, status FROM bookheap_items
WHERE id > sqlc.arg(after_id) ORDER BY id LIMIT sqlc.arg(page_limit);

-- name: BookheapUpdateScanned :execrows
UPDATE bookheap_items SET file_name = ?, size_bytes = ?, mtime_ns = ?, sha256 = ?, format = ?, title = ?,
    authors = ?, language = ?, series = ?, series_index = ?, cover_sha256 = ?, status = ?, error = ?,
    duplicate_of_book_id = ?, duplicate_of_item_id = ?, updated_at = ?
WHERE id = sqlc.arg(id) AND status NOT IN ('queued', 'importing');

-- name: BookheapDeleteIdle :execrows
DELETE FROM bookheap_items WHERE id = ? AND status NOT IN ('queued', 'importing');

-- name: BookheapDuplicateBook :one
SELECT book_id FROM book_files WHERE sha256 = ?;

-- name: BookheapDuplicateItem :one
SELECT id FROM bookheap_items
WHERE sha256 = sqlc.arg(sha256) AND id < sqlc.arg(before_id)
ORDER BY id LIMIT 1;

-- name: BookheapList :many
SELECT * FROM bookheap_items
WHERE (CAST(sqlc.arg(status) AS TEXT) = '' OR status = sqlc.arg(status))
  AND (CAST(sqlc.arg(query) AS TEXT) = ''
    OR instr(lower(title), lower(sqlc.arg(query))) > 0
    OR instr(lower(file_name), lower(sqlc.arg(query))) > 0
    OR EXISTS (SELECT 1 FROM json_each(bookheap_items.authors) a
        WHERE instr(lower(a.value), lower(sqlc.arg(query))) > 0))
  AND (CAST(sqlc.arg(cursor_id) AS INTEGER) = 0
    OR created_at < sqlc.arg(cursor_created)
    OR (created_at = sqlc.arg(cursor_created) AND id < sqlc.arg(cursor_id)))
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: BookheapCount :one
SELECT count(*) FROM bookheap_items
WHERE (CAST(sqlc.arg(status) AS TEXT) = '' OR status = sqlc.arg(status))
  AND (CAST(sqlc.arg(query) AS TEXT) = ''
    OR instr(lower(title), lower(sqlc.arg(query))) > 0
    OR instr(lower(file_name), lower(sqlc.arg(query))) > 0
    OR EXISTS (SELECT 1 FROM json_each(bookheap_items.authors) a
        WHERE instr(lower(a.value), lower(sqlc.arg(query))) > 0));
