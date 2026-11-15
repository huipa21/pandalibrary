-- +goose Up
ALTER TABLE wordbooks ADD COLUMN language TEXT NOT NULL DEFAULT '' CHECK(length(language) <= 35);

-- +goose Down
ALTER TABLE wordbooks DROP COLUMN language;
