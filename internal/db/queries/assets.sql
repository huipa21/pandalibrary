-- name: AssetsGetOwned :one
SELECT * FROM annotation_assets WHERE user_id = ? AND sha256 = ?;

-- name: AssetsInsert :execrows
INSERT INTO annotation_assets (user_id, sha256, media_type, size, width, height, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, sha256) DO NOTHING;

-- name: AssetsDeleteUnused :many
DELETE FROM annotation_assets
WHERE (user_id, sha256) IN (
    SELECT a.user_id, a.sha256 FROM annotation_assets a
    WHERE a.created_at < sqlc.arg(cutoff)
      AND NOT EXISTS (
          SELECT 1 FROM page_annotations p
          WHERE p.user_id = a.user_id AND p.asset_sha256 = a.sha256 AND p.deleted_at IS NULL
      )
    ORDER BY a.created_at, a.user_id, a.sha256
    LIMIT sqlc.arg(batch_size)
)
RETURNING sha256, media_type;

-- name: AssetsHasOwners :one
SELECT EXISTS(SELECT 1 FROM annotation_assets WHERE sha256 = ?);
