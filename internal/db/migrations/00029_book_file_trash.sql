-- +goose Up

-- A format can be moved to Trash while its parent book stays in the library.
ALTER TABLE book_files ADD COLUMN deleted_at INTEGER;
CREATE INDEX book_files_book_active ON book_files (book_id) WHERE deleted_at IS NULL;

-- +goose Down

DROP INDEX book_files_book_active;
ALTER TABLE book_files DROP COLUMN deleted_at;
