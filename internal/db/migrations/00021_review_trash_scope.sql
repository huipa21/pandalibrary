-- +goose Up
-- Entries and bookmarks are outside trash; finalize any deletions made by
-- the earlier trash implementation before restoring their original schema.
DELETE FROM wordbook_entries WHERE deleted_at IS NOT NULL;
DELETE FROM bookmarks WHERE purged != 0;
ALTER TABLE wordbook_entries DROP COLUMN deleted_at;
ALTER TABLE bookmarks DROP COLUMN purged;

CREATE TABLE trash_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_id INTEGER NOT NULL,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL
);
CREATE INDEX trash_reviews_owner ON trash_reviews(user_id);

-- +goose Down
CREATE TEMP TABLE trash_review_down_guard (n INTEGER CHECK (n = 0));
INSERT INTO trash_review_down_guard SELECT count(*) FROM trash_reviews;
DROP TABLE trash_review_down_guard;
DROP TABLE trash_reviews;
ALTER TABLE bookmarks ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wordbook_entries ADD COLUMN deleted_at INTEGER;
