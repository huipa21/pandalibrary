-- +goose Up

CREATE TABLE user_books_v5 (
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id     INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    status      TEXT    NOT NULL DEFAULT 'unread'
                CHECK (status IN ('unread', 'want_to_read', 'reading', 'on_hold', 'rereading', 'finished', 'skimmed', 'abandoned')),
    rating      INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
    started_at  INTEGER,
    finished_at INTEGER,
    updated_at  INTEGER NOT NULL,
    rev         INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
) WITHOUT ROWID;
INSERT INTO user_books_v5 (user_id, book_id, status, rating, started_at, finished_at, updated_at, rev)
SELECT user_id, book_id, status, rating, started_at, finished_at, updated_at, rev FROM user_books;
DROP TABLE user_books;
ALTER TABLE user_books_v5 RENAME TO user_books;
CREATE INDEX user_books_user_rev ON user_books (user_id, rev);
CREATE INDEX user_books_user_status ON user_books (user_id, status);

-- +goose Down

CREATE TABLE user_books_v4 (
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id     INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    status      TEXT    NOT NULL DEFAULT 'unread'
                CHECK (status IN ('unread', 'want_to_read', 'reading', 'finished', 'abandoned')),
    rating      INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
    started_at  INTEGER,
    finished_at INTEGER,
    updated_at  INTEGER NOT NULL,
    rev         INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
) WITHOUT ROWID;
INSERT INTO user_books_v4 (user_id, book_id, status, rating, started_at, finished_at, updated_at, rev)
SELECT user_id, book_id,
    CASE status WHEN 'on_hold' THEN 'reading' WHEN 'rereading' THEN 'reading'
                WHEN 'skimmed' THEN 'finished' ELSE status END,
    rating, started_at, finished_at, updated_at, rev
FROM user_books;
DROP TABLE user_books;
ALTER TABLE user_books_v4 RENAME TO user_books;
CREATE INDEX user_books_user_rev ON user_books (user_id, rev);
CREATE INDEX user_books_user_status ON user_books (user_id, status);
