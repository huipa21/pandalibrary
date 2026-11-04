-- UX2 system and automatic shelf queries. Every book query repeats the catalog
-- visibility predicate (library grant or admin, and not hidden for the viewer).
-- sqlc.arg(rules) is canonical RuleSet JSON validated by the catalog service.

-- name: ShelfSystemGet :one
SELECT s.* FROM shelves s
WHERE s.owner_id = sqlc.arg(owner_id) AND s.system_key = sqlc.arg(system_key);

-- name: ShelfSystemEnsure :exec
INSERT OR IGNORE INTO shelves (kind, owner_id, name, description, created_by, created_at, updated_at, mode, system_key)
VALUES ('private', sqlc.arg(owner_id), sqlc.arg(name), NULL, sqlc.arg(owner_id), sqlc.arg(now), sqlc.arg(now),
    'manual', sqlc.arg(system_key));

-- name: ShelfAutomaticBookCount :one
SELECT count(*) FROM books b
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CASE json_extract(CAST(sqlc.arg(rules) AS TEXT), '$.match')
    WHEN 'all' THEN NOT EXISTS (
        SELECT 1 FROM json_each(CAST(sqlc.arg(rules) AS TEXT), '$.conditions') c
        WHERE COALESCE(CASE json_extract(c.value, '$.field')
            WHEN 'title' THEN instr(lower(b.title), lower(json_extract(c.value, '$.value'))) > 0
            WHEN 'author_id' THEN EXISTS (SELECT 1 FROM book_authors ba
                WHERE ba.book_id = b.id AND ba.author_id = json_extract(c.value, '$.value'))
            WHEN 'tag_id' THEN EXISTS (SELECT 1 FROM book_tags bt
                WHERE bt.book_id = b.id AND bt.tag_id = json_extract(c.value, '$.value'))
            WHEN 'series_id' THEN b.series_id = json_extract(c.value, '$.value')
            WHEN 'language' THEN lower(b.language) = lower(json_extract(c.value, '$.value'))
            WHEN 'format' THEN EXISTS (SELECT 1 FROM book_files bf
                WHERE bf.book_id = b.id AND bf.format = json_extract(c.value, '$.value'))
            WHEN 'reading_status' THEN COALESCE((SELECT ub.status FROM user_books ub
                WHERE ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id), 'unread') = json_extract(c.value, '$.value')
            ELSE 0 END, 0) = 0)
    WHEN 'any' THEN EXISTS (
        SELECT 1 FROM json_each(CAST(sqlc.arg(rules) AS TEXT), '$.conditions') c
        WHERE COALESCE(CASE json_extract(c.value, '$.field')
            WHEN 'title' THEN instr(lower(b.title), lower(json_extract(c.value, '$.value'))) > 0
            WHEN 'author_id' THEN EXISTS (SELECT 1 FROM book_authors ba
                WHERE ba.book_id = b.id AND ba.author_id = json_extract(c.value, '$.value'))
            WHEN 'tag_id' THEN EXISTS (SELECT 1 FROM book_tags bt
                WHERE bt.book_id = b.id AND bt.tag_id = json_extract(c.value, '$.value'))
            WHEN 'series_id' THEN b.series_id = json_extract(c.value, '$.value')
            WHEN 'language' THEN lower(b.language) = lower(json_extract(c.value, '$.value'))
            WHEN 'format' THEN EXISTS (SELECT 1 FROM book_files bf
                WHERE bf.book_id = b.id AND bf.format = json_extract(c.value, '$.value'))
            WHEN 'reading_status' THEN COALESCE((SELECT ub.status FROM user_books ub
                WHERE ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id), 'unread') = json_extract(c.value, '$.value')
            ELSE 0 END, 0) = 1)
    ELSE 0 END) = 1;

-- name: ShelfAutomaticBooks :many
SELECT b.* FROM books b
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (CASE json_extract(CAST(sqlc.arg(rules) AS TEXT), '$.match')
    WHEN 'all' THEN NOT EXISTS (
        SELECT 1 FROM json_each(CAST(sqlc.arg(rules) AS TEXT), '$.conditions') c
        WHERE COALESCE(CASE json_extract(c.value, '$.field')
            WHEN 'title' THEN instr(lower(b.title), lower(json_extract(c.value, '$.value'))) > 0
            WHEN 'author_id' THEN EXISTS (SELECT 1 FROM book_authors ba
                WHERE ba.book_id = b.id AND ba.author_id = json_extract(c.value, '$.value'))
            WHEN 'tag_id' THEN EXISTS (SELECT 1 FROM book_tags bt
                WHERE bt.book_id = b.id AND bt.tag_id = json_extract(c.value, '$.value'))
            WHEN 'series_id' THEN b.series_id = json_extract(c.value, '$.value')
            WHEN 'language' THEN lower(b.language) = lower(json_extract(c.value, '$.value'))
            WHEN 'format' THEN EXISTS (SELECT 1 FROM book_files bf
                WHERE bf.book_id = b.id AND bf.format = json_extract(c.value, '$.value'))
            WHEN 'reading_status' THEN COALESCE((SELECT ub.status FROM user_books ub
                WHERE ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id), 'unread') = json_extract(c.value, '$.value')
            ELSE 0 END, 0) = 0)
    WHEN 'any' THEN EXISTS (
        SELECT 1 FROM json_each(CAST(sqlc.arg(rules) AS TEXT), '$.conditions') c
        WHERE COALESCE(CASE json_extract(c.value, '$.field')
            WHEN 'title' THEN instr(lower(b.title), lower(json_extract(c.value, '$.value'))) > 0
            WHEN 'author_id' THEN EXISTS (SELECT 1 FROM book_authors ba
                WHERE ba.book_id = b.id AND ba.author_id = json_extract(c.value, '$.value'))
            WHEN 'tag_id' THEN EXISTS (SELECT 1 FROM book_tags bt
                WHERE bt.book_id = b.id AND bt.tag_id = json_extract(c.value, '$.value'))
            WHEN 'series_id' THEN b.series_id = json_extract(c.value, '$.value')
            WHEN 'language' THEN lower(b.language) = lower(json_extract(c.value, '$.value'))
            WHEN 'format' THEN EXISTS (SELECT 1 FROM book_files bf
                WHERE bf.book_id = b.id AND bf.format = json_extract(c.value, '$.value'))
            WHEN 'reading_status' THEN COALESCE((SELECT ub.status FROM user_books ub
                WHERE ub.user_id = sqlc.arg(user_id) AND ub.book_id = b.id), 'unread') = json_extract(c.value, '$.value')
            ELSE 0 END, 0) = 1)
    ELSE 0 END) = 1
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR b.sort_title > CAST(sqlc.arg(after_title) AS TEXT)
    OR (b.sort_title = CAST(sqlc.arg(after_title) AS TEXT) AND b.id > sqlc.arg(after_id)))
ORDER BY b.sort_title, b.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: ShelfUnshelvedBookCount :one
SELECT count(*) FROM books b
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND NOT EXISTS (
    SELECT 1 FROM shelf_books sb JOIN shelves s ON s.id = sb.shelf_id
    WHERE sb.book_id = b.id AND s.kind = 'private' AND s.owner_id = sqlc.arg(user_id)
    AND s.mode = 'manual' AND s.system_key IS NULL
);

-- name: ShelfUnshelvedBooks :many
SELECT b.* FROM books b
WHERE (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND NOT EXISTS (
    SELECT 1 FROM shelf_books sb JOIN shelves s ON s.id = sb.shelf_id
    WHERE sb.book_id = b.id AND s.kind = 'private' AND s.owner_id = sqlc.arg(user_id)
    AND s.mode = 'manual' AND s.system_key IS NULL
)
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR b.sort_title > CAST(sqlc.arg(after_title) AS TEXT)
    OR (b.sort_title = CAST(sqlc.arg(after_title) AS TEXT) AND b.id > sqlc.arg(after_id)))
ORDER BY b.sort_title, b.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);
