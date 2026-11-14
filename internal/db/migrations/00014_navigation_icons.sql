-- +goose Up
ALTER TABLE libraries ADD COLUMN icon TEXT NOT NULL DEFAULT ''
    CHECK (length(icon) <= 64);
ALTER TABLE shelves ADD COLUMN icon TEXT NOT NULL DEFAULT ''
    CHECK (length(icon) <= 64);

-- +goose Down
ALTER TABLE shelves DROP COLUMN icon;
ALTER TABLE libraries DROP COLUMN icon;
