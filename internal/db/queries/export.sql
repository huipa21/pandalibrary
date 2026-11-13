-- name: ExportBooks :many
SELECT b.id, b.title, s.name AS series_name, b.series_index,
       CAST(COALESCE((
           SELECT json_group_array(author_name) FROM (
               SELECT a.name AS author_name
               FROM book_authors ba
               JOIN authors a ON a.id = ba.author_id
               WHERE ba.book_id = b.id AND ba.role = 'author'
               ORDER BY ba.position, a.id
           )
       ), '[]') AS TEXT) AS authors,
       CAST(COALESCE((
           SELECT json_group_array(tag_name) FROM (
               SELECT t.name AS tag_name
               FROM book_tags bt
               JOIN tags t ON t.id = bt.tag_id
               WHERE bt.book_id = b.id
               ORDER BY t.name COLLATE NOCASE, t.id
           )
       ), '[]') AS TEXT) AS tags,
       CAST(COALESCE((
           SELECT bi.value
           FROM book_identifiers bi
           WHERE bi.book_id = b.id AND bi.scheme IN ('isbn13', 'isbn10')
           ORDER BY CASE bi.scheme WHEN 'isbn13' THEN 0 ELSE 1 END, bi.value
           LIMIT 1
       ), '') AS TEXT) AS isbn
FROM books b
LEFT JOIN series s ON s.id = b.series_id
WHERE (CAST(sqlc.arg(UserID) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(UserID) OR (b.visibility = 'library' AND (CAST(sqlc.arg(IsAdmin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(UserID)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(UserID)
)
AND b.id IN (SELECT value FROM json_each(CAST(sqlc.arg(BookIDsJSON) AS TEXT)))
ORDER BY b.id;

-- name: ExportHighlights :many
SELECT h.book_id, h.id, h.position, h.text, h.style
FROM highlights h
JOIN books b ON b.id = h.book_id
WHERE h.user_id = sqlc.arg(UserID)
AND h.deleted_at IS NULL
AND (CAST(sqlc.arg(UserID) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(UserID) OR (b.visibility = 'library' AND (CAST(sqlc.arg(IsAdmin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(UserID)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(UserID)
)
AND h.book_id IN (SELECT value FROM json_each(CAST(sqlc.arg(BookIDsJSON) AS TEXT)))
ORDER BY h.book_id, h.position, h.id
LIMIT 10001;

-- name: ExportPageAnnotations :many
SELECT p.book_id, p.id, p.kind, p.locator, p.data
FROM page_annotations p
JOIN books b ON b.id = p.book_id
WHERE p.user_id = sqlc.arg(UserID)
AND p.deleted_at IS NULL
AND (CAST(sqlc.arg(UserID) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(UserID) OR (b.visibility = 'library' AND (CAST(sqlc.arg(IsAdmin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(UserID)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(UserID)
)
AND p.book_id IN (SELECT value FROM json_each(CAST(sqlc.arg(BookIDsJSON) AS TEXT)))
ORDER BY p.book_id, p.position, p.id
LIMIT 10001;

-- name: ExportNotes :many
SELECT n.book_id, n.id, n.highlight_id, n.body_md, n.created_at, n.updated_at
FROM notes n
JOIN books b ON b.id = n.book_id
WHERE n.user_id = sqlc.arg(UserID)
AND n.deleted_at IS NULL
AND EXISTS (
    SELECT 1 FROM highlights h
    WHERE h.id = n.highlight_id AND h.user_id = n.user_id AND h.book_id = n.book_id
    AND h.deleted_at IS NULL
)
AND (CAST(sqlc.arg(UserID) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(UserID) OR (b.visibility = 'library' AND (CAST(sqlc.arg(IsAdmin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(UserID)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(UserID)
)
AND n.book_id IN (SELECT value FROM json_each(CAST(sqlc.arg(BookIDsJSON) AS TEXT)))
ORDER BY n.book_id, n.highlight_id, n.created_at, n.id
LIMIT 10001;

-- name: ExportContentBytes :one
SELECT
    COALESCE((
        SELECT SUM(length(CAST(h.text AS BLOB)))
        FROM highlights h
        JOIN books b ON b.id = h.book_id
        WHERE h.user_id = sqlc.arg(UserID)
        AND h.deleted_at IS NULL
        AND (CAST(sqlc.arg(UserID) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(UserID) OR (b.visibility = 'library' AND (CAST(sqlc.arg(IsAdmin) AS INTEGER) = 1 OR EXISTS (
            SELECT 1 FROM library_access la
            WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(UserID)
        )))))
        AND NOT EXISTS (
            SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(UserID)
        )
        AND h.book_id IN (SELECT value FROM json_each(CAST(sqlc.arg(BookIDsJSON) AS TEXT)))
    ), 0)
    +
    COALESCE((
        SELECT SUM(length(CAST(n.body_md AS BLOB)))
        FROM notes n
        JOIN books b ON b.id = n.book_id
        WHERE n.user_id = sqlc.arg(UserID)
        AND n.deleted_at IS NULL
        AND EXISTS (
            SELECT 1 FROM highlights h
            WHERE h.id = n.highlight_id AND h.user_id = n.user_id AND h.book_id = n.book_id
            AND h.deleted_at IS NULL
        )
        AND (CAST(sqlc.arg(UserID) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(UserID) OR (b.visibility = 'library' AND (CAST(sqlc.arg(IsAdmin) AS INTEGER) = 1 OR EXISTS (
            SELECT 1 FROM library_access la
            WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(UserID)
        )))))
        AND NOT EXISTS (
            SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(UserID)
        )
        AND n.book_id IN (SELECT value FROM json_each(CAST(sqlc.arg(BookIDsJSON) AS TEXT)))
    ), 0)
    +
    COALESCE((
        SELECT SUM(length(CAST(p.data AS BLOB)) + length(CAST(p.locator AS BLOB)))
        FROM page_annotations p
        JOIN books b ON b.id = p.book_id
        WHERE p.user_id = sqlc.arg(UserID)
        AND p.deleted_at IS NULL
        AND (CAST(sqlc.arg(UserID) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(UserID) OR (b.visibility = 'library' AND (CAST(sqlc.arg(IsAdmin) AS INTEGER) = 1 OR EXISTS (
            SELECT 1 FROM library_access la
            WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(UserID)
        )))))
        AND NOT EXISTS (
            SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(UserID)
        )
        AND p.book_id IN (SELECT value FROM json_each(CAST(sqlc.arg(BookIDsJSON) AS TEXT)))
    ), 0);
