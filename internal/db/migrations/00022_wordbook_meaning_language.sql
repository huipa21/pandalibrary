-- +goose Up
ALTER TABLE wordbooks ADD COLUMN meaning_language TEXT NOT NULL DEFAULT '' CHECK(length(meaning_language) <= 35);

-- +goose Down
ALTER TABLE wordbooks DROP COLUMN meaning_language;
