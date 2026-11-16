-- +goose Up
CREATE TABLE metadata_providers_v26 (
    provider   TEXT    PRIMARY KEY CHECK (provider IN (
        'openlibrary', 'googlebooks', 'neodb', 'hardcover', 'crossref', 'openbd', 'douban'
    )),
    enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    api_token  TEXT,
    base_url   TEXT,
    priority   INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (enabled = 0 OR provider IN ('openlibrary', 'googlebooks', 'crossref', 'openbd', 'douban') OR api_token IS NOT NULL)
) WITHOUT ROWID;

INSERT INTO metadata_providers_v26 (provider, enabled, api_token, base_url, priority, updated_at)
SELECT provider, enabled, api_token, base_url, priority, updated_at FROM metadata_providers;

DROP TABLE metadata_providers;
ALTER TABLE metadata_providers_v26 RENAME TO metadata_providers;

INSERT INTO metadata_providers (provider, enabled, api_token, base_url, priority, updated_at) VALUES
    ('crossref', 0, NULL, NULL, 50, CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    ('openbd',   0, NULL, NULL, 60, CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    ('douban',   0, NULL, NULL, 70, CAST(unixepoch('subsec') * 1000 AS INTEGER));

-- +goose Down
CREATE TABLE metadata_providers_v25 (
    provider   TEXT    PRIMARY KEY CHECK (provider IN ('openlibrary', 'googlebooks', 'neodb', 'hardcover')),
    enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    api_token  TEXT,
    base_url   TEXT,
    priority   INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (enabled = 0 OR provider IN ('openlibrary', 'googlebooks') OR api_token IS NOT NULL)
) WITHOUT ROWID;

INSERT INTO metadata_providers_v25 (provider, enabled, api_token, base_url, priority, updated_at)
SELECT provider, enabled, api_token, base_url, priority, updated_at
FROM metadata_providers WHERE provider IN ('openlibrary', 'googlebooks', 'neodb', 'hardcover');

DROP TABLE metadata_providers;
ALTER TABLE metadata_providers_v25 RENAME TO metadata_providers;

DELETE FROM metadata_cache WHERE provider IN ('crossref', 'openbd', 'douban');
