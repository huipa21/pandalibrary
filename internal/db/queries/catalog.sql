-- name: CatalogListLibraries :many
SELECT l.*, (
    SELECT count(*) FROM books b
    WHERE b.library_id = l.id
    AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id)
        OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
            SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
        )))))
    AND NOT EXISTS (SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id))
) AS visible_book_count FROM libraries l
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = l.id AND la.user_id = sqlc.arg(user_id)
))
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR l.name COLLATE NOCASE > CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
    OR (l.name COLLATE NOCASE = CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
        AND l.id > sqlc.arg(after_id)))
ORDER BY l.name COLLATE NOCASE, l.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: CatalogGetLibrary :one
SELECT l.* FROM libraries l
WHERE l.id = sqlc.arg(library_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = l.id AND la.user_id = sqlc.arg(user_id)
));

-- name: CatalogCreateLibrary :one
INSERT INTO libraries (name, slug, created_at, updated_at)
VALUES (?, ?, ?, ?)
RETURNING id, name, slug, created_at, updated_at;

-- name: CatalogUpdateLibrary :one
UPDATE libraries SET name = ?, slug = ?, updated_at = ? WHERE id = ?
RETURNING id, name, slug, created_at, updated_at;

-- name: CatalogDeleteLibrary :execrows
DELETE FROM libraries WHERE id = ?;

-- name: CatalogLibraryNameTaken :one
SELECT count(*) FROM libraries
WHERE name = sqlc.arg(name) COLLATE NOCASE AND id != sqlc.arg(exclude_id);

-- name: CatalogLibrarySlugTaken :one
SELECT count(*) FROM libraries
WHERE slug = sqlc.arg(slug) AND id != sqlc.arg(exclude_id);

-- name: CatalogLibraryBookCount :one
SELECT count(*) FROM books WHERE library_id = ?;

-- name: CatalogLibraryVisibleBookCount :one
SELECT count(*) FROM books b
WHERE b.library_id = sqlc.arg(library_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id)
    OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
        SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
    )))))
AND NOT EXISTS (SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id));

-- name: CatalogDefaultLibrarySetting :one
SELECT value FROM server_settings WHERE key = 'default_library_id';

-- name: CatalogUserRole :one
SELECT role FROM users WHERE id = ?;

-- name: CatalogBookExists :one
SELECT count(*) FROM books WHERE id = ?;

-- name: CatalogListLibraryAccess :many
SELECT user_id, granted_at FROM library_access
WHERE library_id = sqlc.arg(library_id) AND user_id > sqlc.arg(after_id)
ORDER BY user_id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: CatalogGrantLibraryAccess :exec
INSERT INTO library_access (library_id, user_id, granted_at)
VALUES (?, ?, ?)
ON CONFLICT (library_id, user_id) DO NOTHING;

-- name: CatalogRevokeLibraryAccess :exec
DELETE FROM library_access WHERE library_id = ? AND user_id = ?;

-- name: CatalogListHiddenBooks :many
SELECT book_id, hidden_by, created_at FROM book_hidden
WHERE user_id = sqlc.arg(user_id) AND book_id > sqlc.arg(after_id)
ORDER BY book_id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: CatalogHideBook :exec
INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (user_id, book_id) DO NOTHING;

-- name: CatalogUnhideBook :exec
DELETE FROM book_hidden WHERE user_id = ? AND book_id = ?;

-- name: CatalogGetBook :one
SELECT b.* FROM books b
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: CatalogListBooksByTitle :many
SELECT b.* FROM books b
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(library_id) AS INTEGER) = 0 OR b.library_id = sqlc.arg(library_id))
AND (CAST(sqlc.arg(series_id) AS INTEGER) = 0 OR b.series_id = sqlc.arg(series_id))
AND (CAST(sqlc.arg(author_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_authors ba WHERE ba.book_id = b.id AND ba.author_id = sqlc.arg(author_id)
))
AND (CAST(sqlc.arg(tag_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND bt.tag_id = sqlc.arg(tag_id)
))
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR b.sort_title > CAST(sqlc.arg(after_title) AS TEXT)
    OR (b.sort_title = CAST(sqlc.arg(after_title) AS TEXT) AND b.id > sqlc.arg(after_id)))
ORDER BY b.sort_title, b.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: CatalogListBooksByAdded :many
SELECT b.* FROM books b
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(library_id) AS INTEGER) = 0 OR b.library_id = sqlc.arg(library_id))
AND (CAST(sqlc.arg(series_id) AS INTEGER) = 0 OR b.series_id = sqlc.arg(series_id))
AND (CAST(sqlc.arg(author_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_authors ba WHERE ba.book_id = b.id AND ba.author_id = sqlc.arg(author_id)
))
AND (CAST(sqlc.arg(tag_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND bt.tag_id = sqlc.arg(tag_id)
))
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR b.created_at < CAST(sqlc.arg(after_created_at) AS INTEGER)
    OR (b.created_at = CAST(sqlc.arg(after_created_at) AS INTEGER) AND b.id < sqlc.arg(after_id)))
ORDER BY b.created_at DESC, b.id DESC
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: CatalogListBooksBySeries :many
SELECT b.* FROM books b
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(library_id) AS INTEGER) = 0 OR b.library_id = sqlc.arg(library_id))
AND b.series_id = sqlc.arg(series_id)
AND (CAST(sqlc.arg(author_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_authors ba WHERE ba.book_id = b.id AND ba.author_id = sqlc.arg(author_id)
))
AND (CAST(sqlc.arg(tag_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND bt.tag_id = sqlc.arg(tag_id)
))
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR (CAST(sqlc.arg(after_null) AS INTEGER) = 0 AND (
        b.series_index IS NULL
        OR b.series_index > CAST(sqlc.arg(after_index) AS REAL)
        OR (b.series_index = CAST(sqlc.arg(after_index) AS REAL) AND b.id > sqlc.arg(after_id))
    ))
    OR (CAST(sqlc.arg(after_null) AS INTEGER) = 1
        AND b.series_index IS NULL AND b.id > sqlc.arg(after_id)))
ORDER BY (b.series_index IS NULL), b.series_index, b.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: CatalogBookAuthors :many
SELECT a.id, a.name, ba.role, ba.position
FROM book_authors ba
JOIN authors a ON a.id = ba.author_id
JOIN books b ON b.id = ba.book_id
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY ba.position, a.id, ba.role;

-- name: CatalogBookSeries :one
SELECT s.id, s.name, b.series_index
FROM books b JOIN series s ON s.id = b.series_id
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: CatalogBookTags :many
SELECT t.id, t.name FROM book_tags bt
JOIN tags t ON t.id = bt.tag_id
JOIN books b ON b.id = bt.book_id
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY t.name COLLATE NOCASE, t.id;

-- name: CatalogBookIdentifiers :many
SELECT bi.scheme, bi.value FROM book_identifiers bi
JOIN books b ON b.id = bi.book_id
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY bi.scheme, bi.value;

-- name: CatalogBookFiles :many
SELECT f.* FROM book_files f JOIN books b ON b.id = f.book_id
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY f.id;

-- name: CatalogBookFile :one
SELECT f.* FROM book_files f JOIN books b ON b.id = f.book_id
WHERE b.id = sqlc.arg(book_id) AND f.id = sqlc.arg(file_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: CatalogBookFieldSources :many
SELECT fs.* FROM book_field_sources fs JOIN books b ON b.id = fs.book_id
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY fs.field;

-- name: CatalogListAuthors :many
SELECT a.id, a.name, a.sort_name, CAST(count(DISTINCT b.id) AS INTEGER) AS visible_book_count
FROM authors a JOIN book_authors ba ON ba.author_id = a.id JOIN books b ON b.id = ba.book_id
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR a.sort_name COLLATE NOCASE > CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
    OR (a.sort_name COLLATE NOCASE = CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
        AND a.id > sqlc.arg(after_id)))
GROUP BY a.id, a.name, a.sort_name
ORDER BY a.sort_name COLLATE NOCASE, a.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: CatalogGetAuthor :one
SELECT a.id, a.name, a.sort_name, CAST(count(DISTINCT b.id) AS INTEGER) AS visible_book_count
FROM authors a JOIN book_authors ba ON ba.author_id = a.id JOIN books b ON b.id = ba.book_id
WHERE a.id = sqlc.arg(author_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
GROUP BY a.id, a.name, a.sort_name;

-- name: CatalogListSeries :many
SELECT s.id, s.name, s.description, CAST(count(DISTINCT b.id) AS INTEGER) AS visible_book_count
FROM series s JOIN books b ON b.series_id = s.id
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR s.name COLLATE NOCASE > CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
    OR (s.name COLLATE NOCASE = CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
        AND s.id > sqlc.arg(after_id)))
GROUP BY s.id, s.name, s.description
ORDER BY s.name COLLATE NOCASE, s.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: CatalogGetSeries :one
SELECT s.id, s.name, s.description, CAST(count(DISTINCT b.id) AS INTEGER) AS visible_book_count
FROM series s JOIN books b ON b.series_id = s.id
WHERE s.id = sqlc.arg(series_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
GROUP BY s.id, s.name, s.description;

-- name: CatalogListTags :many
SELECT t.id, t.name, CAST(count(DISTINCT b.id) AS INTEGER) AS visible_book_count
FROM tags t JOIN book_tags bt ON bt.tag_id = t.id JOIN books b ON b.id = bt.book_id
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR t.name COLLATE NOCASE > CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
    OR (t.name COLLATE NOCASE = CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
        AND t.id > sqlc.arg(after_id)))
GROUP BY t.id, t.name
ORDER BY t.name COLLATE NOCASE, t.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: CatalogGetTag :one
SELECT t.id, t.name, CAST(count(DISTINCT b.id) AS INTEGER) AS visible_book_count
FROM tags t JOIN book_tags bt ON bt.tag_id = t.id JOIN books b ON b.id = bt.book_id
WHERE t.id = sqlc.arg(tag_id)
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
GROUP BY t.id, t.name;

-- name: CatalogUpdateBook :exec
UPDATE books SET library_id = ?, title = ?, sort_title = ?, subtitle = ?, description = ?,
    language = ?, publisher = ?, published_date = ?, page_count = ?, series_id = ?,
    series_index = ?, updated_at = ?
WHERE id = ?;

-- name: CatalogUpdateCover :exec
UPDATE books SET cover_sha256 = ?, cover_source = ?, updated_at = ? WHERE id = ?;

-- name: CatalogDeleteBook :execrows
DELETE FROM books WHERE id = ?;

-- name: CatalogUpsertFieldSource :exec
INSERT INTO book_field_sources (book_id, field, source, source_ref, chosen_by, chosen_at)
VALUES (?, ?, 'manual', NULL, ?, ?)
ON CONFLICT (book_id, field) DO UPDATE SET
    source = 'manual', source_ref = NULL, chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at;

-- name: CatalogInsertAuthor :exec
INSERT INTO authors (name, sort_name, created_at) VALUES (?, ?, ?)
ON CONFLICT (name) DO NOTHING;

-- name: CatalogAuthorByName :one
SELECT id FROM authors WHERE name = ? COLLATE NOCASE;

-- name: CatalogClearBookAuthors :exec
DELETE FROM book_authors WHERE book_id = ?;

-- name: CatalogInsertBookAuthor :exec
INSERT INTO book_authors (book_id, author_id, role, position) VALUES (?, ?, ?, ?);

-- name: CatalogDeleteOrphanAuthor :exec
DELETE FROM authors WHERE id = ? AND NOT EXISTS (
    SELECT 1 FROM book_authors WHERE author_id = authors.id
);

-- name: CatalogInsertSeries :exec
INSERT INTO series (name, created_at) VALUES (?, ?)
ON CONFLICT (name) DO NOTHING;

-- name: CatalogSeriesByName :one
SELECT id FROM series WHERE name = ? COLLATE NOCASE;

-- name: CatalogInsertTag :exec
INSERT INTO tags (name, created_at) VALUES (?, ?)
ON CONFLICT (name) DO NOTHING;

-- name: CatalogTagByName :one
SELECT id FROM tags WHERE name = ? COLLATE NOCASE;

-- name: CatalogClearBookTags :exec
DELETE FROM book_tags WHERE book_id = ?;

-- name: CatalogInsertBookTag :exec
INSERT INTO book_tags (book_id, tag_id) VALUES (?, ?);

-- name: CatalogClearBookIdentifiers :exec
DELETE FROM book_identifiers WHERE book_id = ?;

-- name: CatalogInsertBookIdentifier :exec
INSERT INTO book_identifiers (book_id, scheme, value) VALUES (?, ?, ?);

-- name: CatalogVisibleBookCount :one
SELECT count(*) FROM books b
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: CatalogMoveFileConflict :one
SELECT EXISTS (
    SELECT 1 FROM book_files source
    JOIN book_files destination ON destination.sha256 = source.sha256
    JOIN books b ON b.id = destination.book_id
    WHERE source.book_id = sqlc.arg(book_id)
      AND b.library_id = sqlc.arg(library_id) AND b.id != sqlc.arg(book_id)
);
