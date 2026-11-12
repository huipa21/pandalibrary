-- +goose Up
ALTER TABLE user_books ADD COLUMN reading_cycle INTEGER NOT NULL DEFAULT 1;
UPDATE user_books SET reading_cycle = 2 WHERE status = 'rereading';

CREATE TABLE reading_cycles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('finished', 'skimmed', 'abandoned')),
    percentage REAL NOT NULL CHECK (percentage BETWEEN 0 AND 1),
    UNIQUE (user_id, book_id, ended_at)
);

-- +goose Down
DROP TABLE reading_cycles;
ALTER TABLE user_books DROP COLUMN reading_cycle;
