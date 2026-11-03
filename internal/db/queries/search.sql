-- name: SearchBooksFTS :many
SELECT b.id, b.title,
    CAST(COALESCE((
        SELECT json_group_array(name) FROM (
            SELECT a.name FROM book_authors ba
            JOIN authors a ON a.id = ba.author_id
            WHERE ba.book_id = b.id ORDER BY ba.position, a.id, ba.role
        )
    ), '[]') AS TEXT) AS authors_json,
    s.id AS series_id, s.name AS series_name, b.series_index, b.cover_sha256,
    CAST(f.rank AS REAL) AS score
FROM books_fts(CAST(sqlc.arg(match_query) AS TEXT)) f
JOIN books b ON b.id = f.rowid
LEFT JOIN series s ON s.id = b.series_id
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND NOT EXISTS (
    SELECT 1 FROM json_each(CAST(sqlc.arg(patterns) AS TEXT)) p
    WHERE NOT (
        (f.title LIKE p.value ESCAPE '\') OR (f.authors LIKE p.value ESCAPE '\')
        OR (f.series LIKE p.value ESCAPE '\') OR (f.tags LIKE p.value ESCAPE '\')
        OR (f.publisher LIKE p.value ESCAPE '\') OR (f.identifiers LIKE p.value ESCAPE '\')
        OR (f.description LIKE p.value ESCAPE '\')
    )
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR f.rank > CAST(sqlc.arg(after_score) AS REAL)
    OR (f.rank = CAST(sqlc.arg(after_score) AS REAL) AND b.id > sqlc.arg(after_id)))
ORDER BY f.rank, b.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: SearchBooksLike :many
SELECT b.id, b.title,
    CAST(COALESCE((
        SELECT json_group_array(name) FROM (
            SELECT a.name FROM book_authors ba
            JOIN authors a ON a.id = ba.author_id
            WHERE ba.book_id = b.id ORDER BY ba.position, a.id, ba.role
        )
    ), '[]') AS TEXT) AS authors_json,
    s.id AS series_id, s.name AS series_name, b.series_index, b.cover_sha256,
    CAST(0 AS REAL) AS score
FROM books_fts f
JOIN books b ON b.id = f.rowid
LEFT JOIN series s ON s.id = b.series_id
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND NOT EXISTS (
    SELECT 1 FROM json_each(CAST(sqlc.arg(patterns) AS TEXT)) p
    WHERE NOT (
        (f.title LIKE p.value ESCAPE '\') OR (f.authors LIKE p.value ESCAPE '\')
        OR (f.series LIKE p.value ESCAPE '\') OR (f.tags LIKE p.value ESCAPE '\')
        OR (f.publisher LIKE p.value ESCAPE '\') OR (f.identifiers LIKE p.value ESCAPE '\')
        OR (f.description LIKE p.value ESCAPE '\')
    )
)
AND b.id > CAST(sqlc.arg(after_id) AS INTEGER)
ORDER BY b.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);
