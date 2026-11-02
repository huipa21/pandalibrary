-- name: NextRev :one
UPDATE sync_counter SET value = value + 1 WHERE id = 1 RETURNING value;
