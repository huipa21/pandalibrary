-- name: ImportCreateJob :one
INSERT INTO import_jobs (source, library_id, user_id, original_name, sha256, created_at)
VALUES (?, ?, ?, ?, ?, ?) RETURNING *;

-- name: ImportResume :exec
UPDATE import_jobs SET status = 'pending' WHERE status = 'processing';

-- name: ImportClaim :one
UPDATE import_jobs SET status = 'processing'
WHERE id = (SELECT id FROM import_jobs WHERE status = 'pending' ORDER BY id LIMIT 1)
RETURNING *;

-- name: ImportJob :one
SELECT * FROM import_jobs WHERE id = ?;

-- name: ImportHistory :many
SELECT * FROM import_jobs
WHERE (CAST(sqlc.arg(before_id) AS INTEGER) = 0 OR id < sqlc.arg(before_id))
ORDER BY id DESC LIMIT sqlc.arg(page_limit);

-- name: ImportFinish :exec
UPDATE import_jobs SET status = ?, error = ?, book_id = ?, duplicate_of_book_id = ?, finished_at = ? WHERE id = ?;

-- name: ImportDuplicate :one
SELECT book_id FROM book_files WHERE sha256 = ?;

-- name: ImportLibrarySlug :one
SELECT id FROM libraries WHERE slug = ?;

-- name: ImportDefaultLibrary :one
SELECT l.id FROM libraries l JOIN server_settings s
ON l.id = CAST(json_extract(s.value, '$') AS INTEGER) WHERE s.key = 'default_library_id';

-- name: ImportLibraries :many
SELECT id, slug FROM libraries ORDER BY id;

-- name: ImportCreateBook :one
INSERT INTO books (library_id, title, sort_title, subtitle, description, language, publisher,
    published_date, page_count, series_id, series_index, cover_sha256, cover_source, added_by, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id;

-- name: ImportTarget :one
SELECT id FROM books WHERE id = sqlc.arg(book_id) AND library_id = sqlc.arg(library_id)
AND NOT EXISTS (SELECT 1 FROM book_hidden h WHERE h.book_id = books.id
    AND h.user_id = CAST(sqlc.arg(user_id) AS INTEGER));

-- name: ImportAuthor :one
INSERT INTO authors (name, sort_name, created_at) VALUES (?, ?, ?)
ON CONFLICT(name) DO UPDATE SET name = authors.name RETURNING id;

-- name: ImportSeries :one
INSERT INTO series (name, created_at) VALUES (?, ?)
ON CONFLICT(name) DO UPDATE SET name = series.name RETURNING id;

-- name: ImportTag :one
INSERT INTO tags (name, created_at) VALUES (?, ?)
ON CONFLICT(name) DO UPDATE SET name = tags.name RETURNING id;

-- name: ImportLinkAuthor :exec
INSERT INTO book_authors (book_id, author_id, role, position) VALUES (?, ?, ?, ?)
ON CONFLICT DO NOTHING;

-- name: ImportLinkTag :exec
INSERT INTO book_tags (book_id, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING;

-- name: ImportIdentifier :exec
INSERT INTO book_identifiers (book_id, scheme, value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING;

-- name: ImportFieldSource :exec
INSERT INTO book_field_sources (book_id, field, source, chosen_by, chosen_at) VALUES (?, ?, 'file', ?, ?);

-- name: ImportFile :exec
INSERT INTO book_files (book_id, sha256, format, size_bytes, original_filename, koreader_md5, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?);