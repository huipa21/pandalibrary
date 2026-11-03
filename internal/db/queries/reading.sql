-- name: ReadingVisibleBook :one
SELECT b.id FROM books b
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: ReadingVisibleBookFile :one
SELECT bf.id FROM book_files bf
JOIN books b ON b.id = bf.book_id
WHERE bf.id = sqlc.arg(book_file_id) AND b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: ReadingGetUserBook :one
SELECT ub.* FROM user_books ub
JOIN books b ON b.id = ub.book_id
WHERE ub.user_id = sqlc.arg(user_id) AND ub.book_id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: ReadingGetProgress :one
SELECT rp.* FROM reading_progress rp
JOIN books b ON b.id = rp.book_id
WHERE rp.user_id = sqlc.arg(user_id) AND rp.book_id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h
    WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: ReadingListHighlights :many
SELECT h.* FROM highlights h
JOIN books b ON b.id = h.book_id
WHERE h.user_id = sqlc.arg(user_id) AND h.book_id = sqlc.arg(book_id)
AND h.deleted_at IS NULL
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden hidden
    WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id)
)
ORDER BY h.position, h.id;

-- name: ReadingListNotes :many
SELECT n.* FROM notes n
JOIN books b ON b.id = n.book_id
WHERE n.user_id = sqlc.arg(user_id) AND n.book_id = sqlc.arg(book_id)
AND n.deleted_at IS NULL
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden hidden
    WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id)
)
ORDER BY n.created_at, n.id;

-- name: ReadingListSettings :many
SELECT * FROM user_settings
WHERE user_id = sqlc.arg(user_id)
ORDER BY key;

-- name: ReadingGetSetting :one
SELECT * FROM user_settings
WHERE user_id = sqlc.arg(user_id) AND key = sqlc.arg(key);

-- name: ReadingUpsertUserBook :execrows
INSERT INTO user_books (user_id, book_id, status, rating, started_at, finished_at, updated_at, rev)
SELECT sqlc.arg(user_id), b.id, sqlc.arg(status), sqlc.narg(rating), sqlc.narg(started_at),
       sqlc.narg(finished_at), sqlc.arg(updated_at), sqlc.arg(rev)
FROM books b
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ON CONFLICT (user_id, book_id) DO UPDATE SET
    status = excluded.status, rating = excluded.rating, started_at = excluded.started_at,
    finished_at = excluded.finished_at, updated_at = excluded.updated_at, rev = excluded.rev
WHERE excluded.updated_at > user_books.updated_at;

-- name: ReadingUpsertProgress :execrows
INSERT INTO reading_progress (
    user_id, book_id, book_file_id, source, locator, percentage, device, device_id, updated_at, rev
)
SELECT sqlc.arg(user_id), b.id, sqlc.narg(book_file_id), sqlc.arg(source), sqlc.narg(locator),
       sqlc.arg(percentage), sqlc.arg(device), sqlc.arg(device_id), sqlc.arg(updated_at),
       sqlc.arg(rev)
FROM books b
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ON CONFLICT (user_id, book_id) DO UPDATE SET
    book_file_id = excluded.book_file_id, source = excluded.source, locator = excluded.locator,
    percentage = excluded.percentage, device = excluded.device, device_id = excluded.device_id,
    updated_at = excluded.updated_at, rev = excluded.rev
WHERE excluded.updated_at > reading_progress.updated_at;

-- name: ReadingUpsertHighlight :execrows
INSERT INTO highlights (
    id, user_id, book_id, book_file_id, locator, position, text, color, chapter,
    created_at, updated_at, deleted_at, rev
)
SELECT sqlc.arg(id), sqlc.arg(user_id), b.id, sqlc.narg(book_file_id), sqlc.arg(locator),
       sqlc.arg(position), sqlc.arg(text), sqlc.arg(color), sqlc.narg(chapter),
       sqlc.arg(created_at), sqlc.arg(updated_at), sqlc.narg(deleted_at), sqlc.arg(rev)
FROM books b
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ON CONFLICT (id) DO UPDATE SET
    book_id = excluded.book_id, book_file_id = excluded.book_file_id,
    locator = excluded.locator, position = excluded.position, text = excluded.text,
    color = excluded.color, chapter = excluded.chapter, updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at, rev = excluded.rev
WHERE highlights.user_id = excluded.user_id AND excluded.updated_at > highlights.updated_at;

-- name: ReadingUpsertNote :execrows
INSERT INTO notes (
    id, user_id, book_id, highlight_id, body_md, created_at, updated_at, deleted_at, rev
)
SELECT sqlc.arg(id), sqlc.arg(user_id), b.id, sqlc.narg(highlight_id), sqlc.arg(body_md),
       sqlc.arg(created_at), sqlc.arg(updated_at), sqlc.narg(deleted_at), sqlc.arg(rev)
FROM books b
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
)
ON CONFLICT (id) DO UPDATE SET
    book_id = excluded.book_id, highlight_id = excluded.highlight_id,
    body_md = excluded.body_md, updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at, rev = excluded.rev
WHERE notes.user_id = excluded.user_id AND excluded.updated_at > notes.updated_at;

-- name: ReadingUpsertSetting :execrows
INSERT INTO user_settings (user_id, key, value, updated_at, rev)
VALUES (sqlc.arg(user_id), sqlc.arg(key), sqlc.arg(value), sqlc.arg(updated_at), sqlc.arg(rev))
ON CONFLICT (user_id, key) DO UPDATE SET
    value = excluded.value, updated_at = excluded.updated_at, rev = excluded.rev
WHERE excluded.updated_at > user_settings.updated_at;

-- name: ReadingInsertSession :execrows
INSERT OR IGNORE INTO reading_sessions (
    id, user_id, book_id, source, device, started_at, ended_at, active_seconds,
    start_percentage, end_percentage, pages_turned, created_at
)
SELECT sqlc.arg(id), sqlc.arg(user_id), b.id, sqlc.arg(source), sqlc.arg(device),
       sqlc.arg(started_at), sqlc.arg(ended_at), sqlc.arg(active_seconds),
       sqlc.narg(start_percentage), sqlc.narg(end_percentage), sqlc.narg(pages_turned),
       sqlc.arg(created_at)
FROM books b
WHERE b.id = sqlc.arg(book_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id)
);

-- name: ReadingGetOwnedHighlight :one
SELECT h.* FROM highlights h
JOIN books b ON b.id = h.book_id
WHERE h.id = sqlc.arg(id) AND h.user_id = sqlc.arg(user_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id));

-- name: ReadingGetOwnedNote :one
SELECT n.* FROM notes n
JOIN books b ON b.id = n.book_id
WHERE n.id = sqlc.arg(id) AND n.user_id = sqlc.arg(user_id)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id));

-- name: ReadingGetHighlightOwner :one
SELECT user_id FROM highlights WHERE id = sqlc.arg(id);

-- name: ReadingGetNoteOwner :one
SELECT user_id FROM notes WHERE id = sqlc.arg(id);

-- name: ReadingGetSessionOwner :one
SELECT user_id FROM reading_sessions WHERE id = sqlc.arg(id);

-- name: ReadingGetHighlightClock :one
SELECT updated_at FROM highlights WHERE id = sqlc.arg(id) AND user_id = sqlc.arg(user_id);

-- name: ReadingGetNoteClock :one
SELECT updated_at FROM notes WHERE id = sqlc.arg(id) AND user_id = sqlc.arg(user_id);

-- name: ReadingGetUserBookClock :one
SELECT updated_at FROM user_books WHERE user_id = sqlc.arg(user_id) AND book_id = sqlc.arg(book_id);

-- name: ReadingGetProgressClock :one
SELECT updated_at FROM reading_progress WHERE user_id = sqlc.arg(user_id) AND book_id = sqlc.arg(book_id);

-- name: ReadingGetSettingClock :one
SELECT updated_at FROM user_settings WHERE user_id = sqlc.arg(user_id) AND key = sqlc.arg(key);

-- name: ReadingGetNoteHighlights :many
SELECT id, updated_at FROM notes
WHERE user_id = sqlc.arg(user_id) AND highlight_id = sqlc.arg(highlight_id) AND deleted_at IS NULL
ORDER BY id;

-- name: ReadingTombstoneNote :exec
UPDATE notes SET updated_at = sqlc.arg(updated_at), deleted_at = sqlc.arg(deleted_at),
    rev = sqlc.arg(rev)
WHERE id = sqlc.arg(id) AND user_id = sqlc.arg(user_id) AND deleted_at IS NULL;

-- name: ReadingDeleteHighlightFTS :exec
DELETE FROM highlights_fts WHERE rowid = (SELECT seq FROM highlights WHERE id = sqlc.arg(id));

-- name: ReadingIndexHighlightFTS :exec
INSERT INTO highlights_fts (rowid, text, user_id, book_id)
SELECT seq, text, user_id, book_id FROM highlights
WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: ReadingDeleteNoteFTS :exec
DELETE FROM notes_fts WHERE rowid = (SELECT seq FROM notes WHERE id = sqlc.arg(id));

-- name: ReadingIndexNoteFTS :exec
INSERT INTO notes_fts (rowid, body, highlight_text, user_id, book_id)
SELECT n.seq, n.body_md, coalesce(h.text, ''), n.user_id, n.book_id
FROM notes n LEFT JOIN highlights h ON h.id = n.highlight_id AND h.deleted_at IS NULL
WHERE n.id = sqlc.arg(id) AND n.deleted_at IS NULL;

-- name: ReadingRefreshHighlightNotesFTS :exec
DELETE FROM notes_fts WHERE rowid IN (
    SELECT seq FROM notes WHERE highlight_id = sqlc.arg(highlight_id)
);

-- name: ReadingReindexHighlightNotesFTS :exec
INSERT INTO notes_fts (rowid, body, highlight_text, user_id, book_id)
SELECT n.seq, n.body_md, coalesce(h.text, ''), n.user_id, n.book_id
FROM notes n JOIN highlights h ON h.id = n.highlight_id
WHERE n.highlight_id = sqlc.arg(highlight_id) AND n.deleted_at IS NULL AND h.deleted_at IS NULL;

-- name: ReadingSearchHighlightsFTS :many
SELECT h.id, h.book_id, h.text AS content, 'highlight' AS kind, h.position, h.created_at
FROM highlights_fts(sqlc.arg(query)) f JOIN highlights h ON h.seq = f.rowid
JOIN books b ON b.id = h.book_id
WHERE h.user_id = sqlc.arg(user_id)
AND h.deleted_at IS NULL
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id))
ORDER BY f.rank, h.id LIMIT sqlc.arg(page_size);

-- name: ReadingSearchNotesFTS :many
SELECT n.id, n.book_id, n.body_md AS content, 'note' AS kind, 0.0 AS position, n.created_at
FROM notes_fts(sqlc.arg(query)) f JOIN notes n ON n.seq = f.rowid
JOIN books b ON b.id = n.book_id
WHERE n.user_id = sqlc.arg(user_id)
AND n.deleted_at IS NULL
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id))
ORDER BY f.rank, n.id LIMIT sqlc.arg(page_size);

-- name: ReadingSearchHighlightsLike :many
SELECT h.id, h.book_id, h.text AS content, 'highlight' AS kind, h.position, h.created_at
FROM highlights h JOIN books b ON b.id = h.book_id
WHERE h.user_id = sqlc.arg(user_id) AND h.deleted_at IS NULL
AND ((h.text LIKE sqlc.arg(pattern) ESCAPE '\'))
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id))
ORDER BY h.position, h.id LIMIT sqlc.arg(page_size);

-- name: ReadingSearchNotesLike :many
SELECT n.id, n.book_id, n.body_md AS content, 'note' AS kind, 0.0 AS position, n.created_at
FROM notes n JOIN books b ON b.id = n.book_id
WHERE n.user_id = sqlc.arg(user_id) AND n.deleted_at IS NULL
AND ((n.body_md LIKE sqlc.arg(pattern) ESCAPE '\')
    OR EXISTS (
        SELECT 1 FROM highlights h
        WHERE h.id = n.highlight_id AND h.deleted_at IS NULL
        AND (h.text LIKE sqlc.arg(pattern) ESCAPE '\')
    ))
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id))
ORDER BY n.created_at DESC, n.id LIMIT sqlc.arg(page_size);

-- name: ReadingPullUserBooks :many
SELECT ub.* FROM user_books ub JOIN books b ON b.id = ub.book_id
WHERE ub.user_id = sqlc.arg(user_id) AND ub.rev > sqlc.arg(cursor) AND ub.rev <= sqlc.arg(high_water)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id))
ORDER BY ub.rev, ub.book_id;

-- name: ReadingPullProgress :many
SELECT rp.* FROM reading_progress rp JOIN books b ON b.id = rp.book_id
WHERE rp.user_id = sqlc.arg(user_id) AND rp.rev > sqlc.arg(cursor) AND rp.rev <= sqlc.arg(high_water)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = sqlc.arg(user_id))
ORDER BY rp.rev, rp.book_id;

-- name: ReadingPullHighlights :many
SELECT h.* FROM highlights h JOIN books b ON b.id = h.book_id
WHERE h.user_id = sqlc.arg(user_id) AND h.rev > sqlc.arg(cursor) AND h.rev <= sqlc.arg(high_water)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id))
ORDER BY h.rev, h.id;

-- name: ReadingPullNotes :many
SELECT n.* FROM notes n JOIN books b ON b.id = n.book_id
WHERE n.user_id = sqlc.arg(user_id) AND n.rev > sqlc.arg(cursor) AND n.rev <= sqlc.arg(high_water)
AND (CAST(sqlc.arg(is_admin) AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = sqlc.arg(user_id)
))
AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = sqlc.arg(user_id))
ORDER BY n.rev, n.id;

-- name: ReadingPullSettings :many
SELECT * FROM user_settings
WHERE user_id = sqlc.arg(user_id) AND rev > sqlc.arg(cursor) AND rev <= sqlc.arg(high_water)
ORDER BY rev, key;

-- name: ReadingSyncHighWater :one
SELECT value FROM sync_counter WHERE id = 1;
