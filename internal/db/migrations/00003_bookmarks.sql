-- Add bookmarks table for saved reading positions.
-- Bookmarks are distinct from highlights, notes, and user_books status.
-- They store a user's saved position with optional label and chapter info.

-- +goose Up

CREATE TABLE bookmarks (
    seq          INTEGER PRIMARY KEY,
    id           TEXT    NOT NULL UNIQUE CHECK (length(id) = 36),       -- UUIDv7
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    book_file_id INTEGER REFERENCES book_files (id) ON DELETE SET NULL, -- file the bookmark was taken from
    locator      TEXT    NOT NULL CHECK (json_valid(locator)),          -- {"cfi": ...} or {"page": n, "rects": [...]}
    position     REAL    NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 1), -- book fraction, for ordering
    label        TEXT    NOT NULL DEFAULT '',                           -- optional short label (e.g., "Chapter 5 start")
    chapter      TEXT,                                                  -- optional chapter title
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,                                              -- tombstone for sync
    rev          INTEGER NOT NULL
);
CREATE INDEX bookmarks_user_book ON bookmarks (user_id, book_id, position) WHERE deleted_at IS NULL;
CREATE INDEX bookmarks_user_rev ON bookmarks (user_id, rev);
CREATE INDEX bookmarks_user_created ON bookmarks (user_id, created_at DESC) WHERE deleted_at IS NULL;

-- +goose Down

DROP TABLE bookmarks;
