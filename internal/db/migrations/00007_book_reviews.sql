-- +goose Up
CREATE TABLE book_reviews (
    id         INTEGER PRIMARY KEY,
    book_id    INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body       TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 10000),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (book_id, user_id)
);
CREATE INDEX book_reviews_book_updated ON book_reviews (book_id, updated_at DESC, id DESC);

-- +goose Down
DROP TABLE book_reviews;
