-- name: AuthCountUsers :one
SELECT count(*) FROM users;

-- name: AuthGetUserByUsername :one
SELECT id, username, display_name, password_hash, role, locale, disabled, created_at, updated_at
FROM users
WHERE username = ? COLLATE NOCASE;

-- name: AuthGetUserByID :one
SELECT id, username, display_name, password_hash, role, locale, disabled, created_at, updated_at
FROM users
WHERE id = ?;

-- name: AuthCreateUser :one
INSERT INTO users (username, display_name, password_hash, role, locale, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
RETURNING id, username, display_name, password_hash, role, locale, disabled, created_at, updated_at;

-- name: AuthUpdatePassword :exec
UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?;

-- name: AuthUpdateProfile :exec
UPDATE users SET display_name = ?, locale = ?, updated_at = ? WHERE id = ?;

-- name: AuthSetUserDisabled :exec
UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?;

-- name: AuthCreateSession :exec
INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- name: AuthGetSession :one
SELECT users.id, users.username, users.display_name, users.role, users.locale, users.disabled,
       sessions.expires_at, sessions.last_seen_at
FROM sessions
JOIN users ON users.id = sessions.user_id
WHERE sessions.token_hash = ?;

-- name: AuthTouchSession :exec
UPDATE sessions
SET last_seen_at = ?, expires_at = ?
WHERE token_hash = ? AND last_seen_at <= ?;

-- name: AuthDeleteSession :exec
DELETE FROM sessions WHERE token_hash = ?;

-- name: AuthRevokeUserSessions :exec
DELETE FROM sessions WHERE user_id = ?;

-- name: AuthListAppPasswords :many
SELECT id, user_id, kind, label, created_at, last_used_at
FROM app_passwords
WHERE user_id = ?
ORDER BY created_at DESC, id DESC;

-- name: AuthCreateAppPassword :one
INSERT INTO app_passwords (user_id, kind, label, secret_hash, created_at)
VALUES (?, ?, ?, ?, ?)
RETURNING id, user_id, kind, label, created_at, last_used_at;

-- name: AuthGetAppPasswordByID :one
SELECT id, user_id, kind, label, secret_hash, created_at, last_used_at
FROM app_passwords
WHERE id = ? AND user_id = ?;

-- name: AuthDeleteAppPassword :exec
DELETE FROM app_passwords WHERE id = ? AND user_id = ?;

-- name: AuthGetAppPasswordByHash :one
SELECT app_passwords.id, app_passwords.user_id, app_passwords.kind, app_passwords.label,
       users.username, users.role, users.disabled
FROM app_passwords
JOIN users ON users.id = app_passwords.user_id
WHERE app_passwords.secret_hash = ? AND app_passwords.kind = ?;

-- name: AuthTouchAppPassword :exec
UPDATE app_passwords SET last_used_at = ? WHERE id = ?;
