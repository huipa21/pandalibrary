-- +goose Up
CREATE TABLE dictionary_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    base_url   TEXT,                                  -- online dictionary API base URL; NULL disables lookup
    api_key    TEXT,                                  -- write-only via API; sent as a Bearer token
    updated_at INTEGER NOT NULL
);

INSERT INTO dictionary_settings (id, base_url, api_key, updated_at)
VALUES (1, NULL, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER));

-- +goose Down
DROP TABLE dictionary_settings;
