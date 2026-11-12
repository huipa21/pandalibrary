-- name: AdminListUsers :many
SELECT * FROM users
WHERE (CAST(sqlc.arg(after_id) AS INTEGER) = 0
   OR username > sqlc.arg(after_username) COLLATE NOCASE
   OR (username = sqlc.arg(after_username) COLLATE NOCASE AND id > sqlc.arg(after_id)))
  AND (CAST(sqlc.arg(search) AS TEXT) = ''
    OR ((CAST(sqlc.arg(category) AS TEXT) = 'all' OR sqlc.arg(category) = 'username') AND instr(lower(username), lower(sqlc.arg(search))) > 0)
    OR ((sqlc.arg(category) = 'all' OR sqlc.arg(category) = 'display_name') AND instr(lower(display_name), lower(sqlc.arg(search))) > 0)
    OR ((sqlc.arg(category) = 'all' OR sqlc.arg(category) = 'role') AND instr(lower(role), lower(sqlc.arg(search))) > 0)
    OR ((sqlc.arg(category) = 'all' OR sqlc.arg(category) = 'locale') AND instr(lower(locale), lower(sqlc.arg(search))) > 0))
ORDER BY username COLLATE NOCASE, id
LIMIT sqlc.arg(page_limit);

-- name: AdminCountEnabled :one
SELECT count(*) FROM users WHERE role = 'admin' AND disabled = 0;

-- name: AdminUpdateUser :one
UPDATE users
SET username = ?, display_name = ?, role = ?, locale = ?, disabled = ?, updated_at = ?
WHERE id = ?
RETURNING *;

-- name: AdminDeleteUser :exec
DELETE FROM users WHERE id = ?;

-- name: AdminRevokeAppPasswords :exec
DELETE FROM app_passwords WHERE user_id = ?;
