-- +goose Up
ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''
    CHECK (length(email) <= 254);

-- +goose Down
ALTER TABLE users DROP COLUMN email;
