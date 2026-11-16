-- +goose Up
CREATE TABLE dictionary_providers (
    id         INTEGER PRIMARY KEY,
    kind       TEXT    NOT NULL CHECK (kind IN ('mw-collegiate', 'mw-thesaurus', 'custom')),
    name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    base_url   TEXT,                                  -- custom providers only
    api_key    TEXT,                                  -- write-only via API
    enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    priority   INTEGER NOT NULL,                      -- lower = queried and shown first
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'custom') = (base_url IS NOT NULL)),
    CHECK (enabled = 0 OR kind = 'custom' OR api_key IS NOT NULL)
);
CREATE UNIQUE INDEX dictionary_providers_preset ON dictionary_providers(kind) WHERE kind <> 'custom';

INSERT INTO dictionary_providers (kind, name, base_url, api_key, enabled, priority, created_at, updated_at) VALUES
    ('mw-collegiate', 'Merriam-Webster''s Collegiate Dictionary', NULL, NULL, 0, 10,
     CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    ('mw-thesaurus', 'Merriam-Webster''s Collegiate Thesaurus', NULL, NULL, 0, 20,
     CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER));

INSERT INTO dictionary_providers (kind, name, base_url, api_key, enabled, priority, created_at, updated_at)
SELECT 'custom', 'Custom dictionary API', base_url, api_key, 1, 100, updated_at, updated_at
FROM dictionary_settings WHERE base_url IS NOT NULL;

DROP TABLE dictionary_settings;

-- +goose Down
CREATE TABLE dictionary_settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    base_url   TEXT,
    api_key    TEXT,
    updated_at INTEGER NOT NULL
);

INSERT INTO dictionary_settings (id, base_url, api_key, updated_at)
VALUES (1, (SELECT base_url FROM dictionary_providers WHERE kind = 'custom' ORDER BY priority, id LIMIT 1),
        (SELECT api_key FROM dictionary_providers WHERE kind = 'custom' ORDER BY priority, id LIMIT 1),
        CAST(unixepoch('subsec') * 1000 AS INTEGER));

DROP TABLE dictionary_providers;
