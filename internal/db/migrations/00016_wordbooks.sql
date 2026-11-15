-- +goose Up
CREATE TABLE wordbooks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(is_default = 0 OR archived = 0)
);
CREATE UNIQUE INDEX wordbooks_user_default ON wordbooks(user_id) WHERE is_default = 1;
CREATE INDEX wordbooks_user ON wordbooks(user_id, id);
CREATE TABLE wordbook_entries (
    id INTEGER PRIMARY KEY,
    wordbook_id INTEGER NOT NULL REFERENCES wordbooks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('word', 'phrase', 'sentence', 'passage')),
    text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 100000),
    definition TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    dictionary_entries TEXT NOT NULL CHECK(json_valid(dictionary_entries)),
    source TEXT NOT NULL CHECK(json_valid(source)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX wordbook_entries_book ON wordbook_entries(wordbook_id, id);

-- +goose Down
DROP TABLE wordbook_entries;
DROP TABLE wordbooks;
