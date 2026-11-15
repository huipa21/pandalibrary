-- +goose Up
ALTER TABLE books ADD COLUMN deleted_at INTEGER;
ALTER TABLE wordbooks ADD COLUMN deleted_at INTEGER;
ALTER TABLE wordbook_entries ADD COLUMN deleted_at INTEGER;
ALTER TABLE highlights ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookmarks ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page_annotations ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;
CREATE TABLE trash_highlight_notes (
    highlight_id TEXT NOT NULL REFERENCES highlights(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    deleted_rev INTEGER NOT NULL,
    PRIMARY KEY (highlight_id, note_id)
) WITHOUT ROWID;

CREATE VIEW active_books AS
SELECT id, library_id, title, sort_title, subtitle, description, language, publisher,
       published_date, page_count, series_id, series_index, cover_sha256, cover_source,
       added_by, created_at, updated_at, owner_id, visibility, age_rating, content_rating, series_total
FROM books WHERE deleted_at IS NULL;

-- +goose Down
CREATE TEMP TABLE trash_down_guard (n INTEGER CHECK (n = 0));
INSERT INTO trash_down_guard SELECT
    (SELECT count(*) FROM books WHERE deleted_at IS NOT NULL) +
    (SELECT count(*) FROM wordbooks WHERE deleted_at IS NOT NULL) +
    (SELECT count(*) FROM wordbook_entries WHERE deleted_at IS NOT NULL) +
    (SELECT count(*) FROM highlights WHERE deleted_at IS NOT NULL) +
    (SELECT count(*) FROM notes WHERE deleted_at IS NOT NULL) +
    (SELECT count(*) FROM bookmarks WHERE deleted_at IS NOT NULL) +
    (SELECT count(*) FROM page_annotations WHERE deleted_at IS NOT NULL);
DROP TABLE trash_down_guard;
DROP VIEW active_books;
DROP TABLE trash_highlight_notes;
ALTER TABLE page_annotations DROP COLUMN purged;
ALTER TABLE bookmarks DROP COLUMN purged;
ALTER TABLE notes DROP COLUMN purged;
ALTER TABLE highlights DROP COLUMN purged;
ALTER TABLE wordbook_entries DROP COLUMN deleted_at;
ALTER TABLE wordbooks DROP COLUMN deleted_at;
ALTER TABLE books DROP COLUMN deleted_at;
