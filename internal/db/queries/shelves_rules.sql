-- UX2 system and automatic shelf queries. Every book query repeats the catalog
-- visibility predicate (library grant or admin, and not hidden for the viewer).
-- sqlc.arg(rule_groups) is canonical RuleGroup JSON validated by the catalog service.
-- Rule provenance is live, viewer-scoped, and unioned with manual shelf_books.

-- name: ShelfSystemGet :one
SELECT s.* FROM shelves s
WHERE s.owner_id = sqlc.arg(owner_id) AND s.system_key = sqlc.arg(system_key);

-- name: ShelfSystemEnsure :exec
INSERT OR IGNORE INTO shelves (kind, owner_id, name, description, created_by, created_at, updated_at, mode, system_key)
VALUES ('private', sqlc.arg(owner_id), sqlc.arg(name), NULL, sqlc.arg(owner_id), sqlc.arg(now), sqlc.arg(now),
    'manual', sqlc.arg(system_key));

-- name: ShelfAutomaticBookCount :one
SELECT count(*) FROM books b
WHERE (CAST(sqlc.arg(library_id) AS INTEGER) = 0 OR b.library_id = sqlc.arg(library_id))
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (EXISTS (SELECT 1 FROM shelf_books sb
    WHERE sb.shelf_id = sqlc.arg(shelf_id) AND sb.book_id = b.id)
OR EXISTS (SELECT 1 FROM json_each(CAST(sqlc.arg(rule_groups) AS TEXT)) g
WHERE (CASE json_extract(g.value, '$.rules.match')
    WHEN 'all' THEN NOT EXISTS (
        SELECT 1 FROM json_each(g.value, '$.rules.conditions') c
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
        SELECT 1 FROM json_each(g.value, '$.rules.conditions') c
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
    ELSE 0 END) = 1));

-- name: ShelfAutomaticBooks :many
SELECT b.* FROM books b
CROSS JOIN (SELECT CAST(sqlc.arg(sort_mode) AS TEXT) AS sort_mode) browse
WHERE (CAST(sqlc.arg(library_id) AS INTEGER) = 0 OR b.library_id = sqlc.arg(library_id))
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND (EXISTS (SELECT 1 FROM shelf_books sb
    WHERE sb.shelf_id = sqlc.arg(shelf_id) AND sb.book_id = b.id)
OR EXISTS (SELECT 1 FROM json_each(CAST(sqlc.arg(rule_groups) AS TEXT)) g
WHERE (CASE json_extract(g.value, '$.rules.match')
    WHEN 'all' THEN NOT EXISTS (
        SELECT 1 FROM json_each(g.value, '$.rules.conditions') c
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
        SELECT 1 FROM json_each(g.value, '$.rules.conditions') c
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
    ELSE 0 END) = 1))
AND (CAST(sqlc.arg(series_id) AS INTEGER) = 0 OR b.series_id = sqlc.arg(series_id))
AND (CAST(sqlc.arg(author_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_authors ba WHERE ba.book_id = b.id AND ba.author_id = sqlc.arg(author_id)
))
AND (CAST(sqlc.arg(tag_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND bt.tag_id = sqlc.arg(tag_id)
))
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR (browse.sort_mode = 'title' AND (
        b.sort_title > CAST(sqlc.arg(after_title) AS TEXT)
        OR (b.sort_title = CAST(sqlc.arg(after_title) AS TEXT) AND b.id > sqlc.arg(after_id))))
    OR (browse.sort_mode = 'added' AND (
        b.created_at < CAST(sqlc.arg(after_created_at) AS INTEGER)
        OR (b.created_at = CAST(sqlc.arg(after_created_at) AS INTEGER) AND b.id < sqlc.arg(after_id))))
    OR (browse.sort_mode = 'series' AND (
        (CAST(sqlc.arg(after_null) AS INTEGER) = 0 AND (
            b.series_index IS NULL
            OR b.series_index > CAST(sqlc.arg(after_index) AS REAL)
            OR (b.series_index = CAST(sqlc.arg(after_index) AS REAL) AND b.id > sqlc.arg(after_id))))
        OR (CAST(sqlc.arg(after_null) AS INTEGER) = 1
            AND b.series_index IS NULL AND b.id > sqlc.arg(after_id)))))
ORDER BY
    CASE WHEN browse.sort_mode = 'title' THEN b.sort_title END,
    CASE WHEN browse.sort_mode = 'added' THEN b.created_at END DESC,
    CASE WHEN browse.sort_mode = 'series' THEN b.series_index IS NULL END,
    CASE WHEN browse.sort_mode = 'series' THEN b.series_index END,
    CASE WHEN browse.sort_mode = 'added' THEN b.id END DESC,
    b.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);

-- name: ShelfRuleMatchingBookIDs :many
SELECT b.id FROM books b
WHERE (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND EXISTS (SELECT 1 FROM json_each(CAST(sqlc.arg(rule_groups) AS TEXT)) g
WHERE (CASE json_extract(g.value, '$.rules.match')
    WHEN 'all' THEN NOT EXISTS (
        SELECT 1 FROM json_each(g.value, '$.rules.conditions') c
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
        SELECT 1 FROM json_each(g.value, '$.rules.conditions') c
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
    ELSE 0 END) = 1)
ORDER BY b.sort_title, b.id;

-- name: ShelfUnshelvedBookCount :one
SELECT count(*) FROM books b
WHERE (CAST(sqlc.arg(library_id) AS INTEGER) = 0 OR b.library_id = sqlc.arg(library_id))
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND NOT EXISTS (
    SELECT 1 FROM shelf_books sb JOIN shelves s ON s.id = sb.shelf_id
    WHERE sb.book_id = b.id AND s.kind = 'private' AND s.owner_id = sqlc.arg(user_id)
    AND s.system_key IS NULL
);

-- name: ShelfUnshelvedBooks :many
SELECT b.* FROM books b
CROSS JOIN (SELECT CAST(sqlc.arg(sort_mode) AS TEXT) AS sort_mode) browse
WHERE (CAST(sqlc.arg(library_id) AS INTEGER) = 0 OR b.library_id = sqlc.arg(library_id))
AND (CAST(sqlc.arg(user_id) AS INTEGER) > 0 AND (b.visibility = 'public' OR b.owner_id = sqlc.arg(user_id) OR (b.visibility = 'library' AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
)))))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
AND NOT EXISTS (
    SELECT 1 FROM shelf_books sb JOIN shelves s ON s.id = sb.shelf_id
    WHERE sb.book_id = b.id AND s.kind = 'private' AND s.owner_id = sqlc.arg(user_id)
    AND s.system_key IS NULL
)
AND (CAST(sqlc.arg(series_id) AS INTEGER) = 0 OR b.series_id = sqlc.arg(series_id))
AND (CAST(sqlc.arg(author_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_authors ba WHERE ba.book_id = b.id AND ba.author_id = sqlc.arg(author_id)
))
AND (CAST(sqlc.arg(tag_id) AS INTEGER) = 0 OR EXISTS (
    SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND bt.tag_id = sqlc.arg(tag_id)
))
AND (CAST(sqlc.arg(after_id) AS INTEGER) = 0
    OR (browse.sort_mode = 'title' AND (
        b.sort_title > CAST(sqlc.arg(after_title) AS TEXT)
        OR (b.sort_title = CAST(sqlc.arg(after_title) AS TEXT) AND b.id > sqlc.arg(after_id))))
    OR (browse.sort_mode = 'added' AND (
        b.created_at < CAST(sqlc.arg(after_created_at) AS INTEGER)
        OR (b.created_at = CAST(sqlc.arg(after_created_at) AS INTEGER) AND b.id < sqlc.arg(after_id))))
    OR (browse.sort_mode = 'series' AND (
        (CAST(sqlc.arg(after_null) AS INTEGER) = 0 AND (
            b.series_index IS NULL
            OR b.series_index > CAST(sqlc.arg(after_index) AS REAL)
            OR (b.series_index = CAST(sqlc.arg(after_index) AS REAL) AND b.id > sqlc.arg(after_id))))
        OR (CAST(sqlc.arg(after_null) AS INTEGER) = 1
            AND b.series_index IS NULL AND b.id > sqlc.arg(after_id)))))
ORDER BY
    CASE WHEN browse.sort_mode = 'title' THEN b.sort_title END,
    CASE WHEN browse.sort_mode = 'added' THEN b.created_at END DESC,
    CASE WHEN browse.sort_mode = 'series' THEN b.series_index IS NULL END,
    CASE WHEN browse.sort_mode = 'series' THEN b.series_index END,
    CASE WHEN browse.sort_mode = 'added' THEN b.id END DESC,
    b.id
LIMIT CAST(sqlc.arg(page_size) AS INTEGER);
