-- name: MetadataListProviders :many
SELECT * FROM metadata_providers ORDER BY priority, provider;

-- name: MetadataGetProvider :one
SELECT * FROM metadata_providers WHERE provider = ?;

-- name: MetadataUpdateProvider :execrows
UPDATE metadata_providers
SET enabled = ?, api_token = ?, base_url = ?, priority = ?, updated_at = ?
WHERE provider = ?;

-- name: MetadataGetCache :one
SELECT * FROM metadata_cache WHERE provider = ? AND request_key = ?;

-- name: MetadataUpsertCache :exec
INSERT INTO metadata_cache (provider, request_key, status, schema_version, response, fetched_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (provider, request_key) DO UPDATE SET
    status = excluded.status, schema_version = excluded.schema_version,
    response = excluded.response, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at;

-- name: MetadataClearProviderCache :exec
DELETE FROM metadata_cache WHERE provider = ?;

-- name: MetadataUpsertFieldSource :exec
INSERT INTO book_field_sources (book_id, field, source, source_ref, chosen_by, chosen_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (book_id, field) DO UPDATE SET
    source = excluded.source, source_ref = excluded.source_ref,
    chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at;
