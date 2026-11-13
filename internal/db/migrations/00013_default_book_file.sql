-- +goose Up
ALTER TABLE book_files ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1));
CREATE UNIQUE INDEX book_files_default ON book_files (book_id) WHERE is_default = 1;

-- +goose Down
DROP INDEX book_files_default;
ALTER TABLE book_files DROP COLUMN is_default;
