-- name: ShelfList :many
SELECT s.* FROM shelves s
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR s.kind = 'shared'
    OR (s.kind = 'private' AND s.owner_id = CAST(sqlc.arg(user_id) AS INTEGER)))
AND (s.system_key IS NULL OR s.owner_id = CAST(sqlc.arg(user_id) AS INTEGER))
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR (CASE WHEN s.system_key IS NULL THEN 1 ELSE 0 END) > CAST(sqlc.arg(after_rank) AS INTEGER)
    OR ((CASE WHEN s.system_key IS NULL THEN 1 ELSE 0 END) = CAST(sqlc.arg(after_rank) AS INTEGER)
        AND (s.name COLLATE NOCASE > CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
            OR (s.name COLLATE NOCASE = CAST(sqlc.arg(after_name) AS TEXT) COLLATE NOCASE
                AND s.id > sqlc.arg(after_id)))))
ORDER BY (CASE WHEN s.system_key IS NULL THEN 1 ELSE 0 END), s.name COLLATE NOCASE, s.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: ShelfGet :one
SELECT s.* FROM shelves s
WHERE s.id = sqlc.arg(shelf_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR s.kind = 'shared'
    OR (s.kind = 'private' AND s.owner_id = CAST(sqlc.arg(user_id) AS INTEGER)))
AND (s.system_key IS NULL OR s.owner_id = CAST(sqlc.arg(user_id) AS INTEGER));

-- name: ShelfNameTaken :one
SELECT count(*) FROM shelves
WHERE kind = sqlc.arg(kind) AND name = sqlc.arg(name) COLLATE NOCASE
AND id != sqlc.arg(exclude_id) AND system_key IS NULL
AND (kind = 'shared' OR owner_id = sqlc.narg(owner_id));

-- name: ShelfCreate :one
INSERT INTO shelves (kind, owner_id, name, description, created_by, created_at, updated_at, mode, rules)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: ShelfUpdate :one
UPDATE shelves SET name = ?, description = ?, rules = ?, updated_at = ? WHERE id = ?
RETURNING *;
-- name: ShelfDelete :execrows
DELETE FROM shelves WHERE id = ?;

-- name: ShelfTouch :exec
UPDATE shelves SET updated_at = ? WHERE id = ?;

-- name: ShelfVisibleBookCount :one
SELECT count(*) FROM shelf_books sb
JOIN books b ON b.id = sb.book_id
WHERE sb.shelf_id = sqlc.arg(shelf_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: ShelfVisibleBookIDs :many
SELECT sb.book_id FROM shelf_books sb
JOIN books b ON b.id = sb.book_id
WHERE sb.shelf_id = sqlc.arg(shelf_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ORDER BY sb.position, sb.book_id;

-- name: ShelfOrderedMembers :many
SELECT sb.book_id, sb.position,
    CAST(CASE WHEN (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
        SELECT 1 FROM library_access la
        WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
    )) AND NOT EXISTS (
        SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
    ) THEN 1 ELSE 0 END AS INTEGER) AS is_visible
FROM shelf_books sb
JOIN books b ON b.id = sb.book_id
WHERE sb.shelf_id = sqlc.arg(shelf_id)
ORDER BY sb.position, sb.book_id;

-- name: ShelfInsertBook :exec
INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at)
VALUES (?, ?, ?, ?, ?);

-- name: ShelfUpdateBookPosition :exec
UPDATE shelf_books SET position = ? WHERE shelf_id = ? AND book_id = ?;

-- name: ShelfRemoveBook :execrows
DELETE FROM shelf_books WHERE shelf_id = ? AND book_id = ?;

-- name: ShelfListContainingBook :many
SELECT s.* FROM shelves s
WHERE s.mode = 'manual'
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR s.kind = 'shared'
    OR (s.kind = 'private' AND s.owner_id = CAST(sqlc.arg(user_id) AS INTEGER)))
AND (s.system_key IS NULL OR s.owner_id = CAST(sqlc.arg(user_id) AS INTEGER))
AND EXISTS (
    SELECT 1 FROM shelf_books sb WHERE sb.shelf_id = s.id AND sb.book_id = sqlc.arg(book_id)
)
ORDER BY s.name COLLATE NOCASE, s.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);