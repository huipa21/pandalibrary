-- +goose Up
ALTER TABLE books ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE books ADD COLUMN visibility TEXT NOT NULL DEFAULT 'library'
    CHECK (visibility IN ('public', 'private', 'library'));
ALTER TABLE bookheap_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'library'
    CHECK (visibility IN ('public', 'private', 'library'));
CREATE INDEX idx_books_owner ON books(owner_id);

-- +goose Down
DROP INDEX idx_books_owner;
ALTER TABLE bookheap_items DROP COLUMN visibility;
ALTER TABLE books DROP COLUMN visibility;
ALTER TABLE books DROP COLUMN owner_id;
