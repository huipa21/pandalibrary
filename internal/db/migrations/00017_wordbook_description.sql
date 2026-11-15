-- +goose Up
ALTER TABLE wordbooks ADD COLUMN description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000);
CREATE INDEX wordbook_entries_source_book ON wordbook_entries(json_extract(source, '$.book_id'));

-- +goose Down
DROP INDEX wordbook_entries_source_book;
ALTER TABLE wordbooks DROP COLUMN description;
