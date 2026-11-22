-- +goose Up
CREATE TABLE metadata_providers_v28 (
    provider   TEXT    PRIMARY KEY CHECK (provider IN (
        'openlibrary', 'googlebooks', 'neodb', 'hardcover', 'crossref', 'openbd', 'douban', 'amazon', 'goodreads'
    )),
    enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    api_token  TEXT,
    base_url   TEXT,
    priority   INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (enabled = 0 OR provider IN (
        'openlibrary', 'googlebooks', 'crossref', 'openbd', 'douban', 'amazon', 'goodreads'
    ) OR api_token IS NOT NULL)
) WITHOUT ROWID;

INSERT INTO metadata_providers_v28 (provider, enabled, api_token, base_url, priority, updated_at)
SELECT provider, enabled, api_token, base_url, priority, updated_at FROM metadata_providers;

DROP TABLE metadata_providers;
ALTER TABLE metadata_providers_v28 RENAME TO metadata_providers;

INSERT INTO metadata_providers (provider, enabled, api_token, base_url, priority, updated_at) VALUES
    ('amazon',    1, NULL, NULL,  5, CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    ('goodreads', 1, NULL, NULL, 15, CAST(unixepoch('subsec') * 1000 AS INTEGER));

-- +goose Down
CREATE TABLE metadata_providers_v27 (
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

INSERT INTO metadata_providers_v27 (provider, enabled, api_token, base_url, priority, updated_at)
SELECT provider, enabled, api_token, base_url, priority, updated_at
FROM metadata_providers WHERE provider IN ('openlibrary', 'googlebooks', 'neodb', 'hardcover', 'crossref', 'openbd', 'douban');

DROP TABLE metadata_providers;
ALTER TABLE metadata_providers_v27 RENAME TO metadata_providers;

DELETE FROM metadata_cache WHERE provider IN ('amazon', 'goodreads');
