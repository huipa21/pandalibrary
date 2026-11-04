# UX7: Administrator account lifecycle API

- Status: Done
- Wave: 1; dependencies: baseline `05326ce`; migration: no
- Branch/worktree: `task/ux7` / `..\pandalibrary-ux7`

## Read first and ownership

Read [the plan](../plans/sidebar-dashboard-plan.md), A1/W5 hand-offs,
`internal/auth/service.go`, auth HTTP/middleware, auth queries, CLI account
commands, and users/FK schema. Own new auth admin-operation files/tests,
localized auth helper adjustments where reuse requires them,
`internal/httpapi/admin_users*.go`, separate
`internal/db/queries/admin_users.sql`/generated file, and one app mount line.
No migrations/models, web, shelves, dashboard, build or dependency changes.
Keep existing CLI/self-profile/session behavior working.

## Implement and freeze these contracts

1. Server-authorized routes, all requiring a live browser session AND admin:
   - GET `/api/v1/admin/users?limit=&cursor=` -> Page<AdminUser>.
   - POST `/api/v1/admin/users` -> 201 `{user:AdminUser}`.
   - GET `/api/v1/admin/users/{id}` -> `{user:AdminUser}`.
   - PATCH `/api/v1/admin/users/{id}` -> `{user:AdminUser}`.
   - DELETE `/api/v1/admin/users/{id}` -> `{deleted:true}`.
   - POST `/api/v1/admin/users/{id}/reset-password` body `{password:string}`
     -> `{reset:true}`.
   - POST `/api/v1/admin/users/{id}/revoke-credentials` body `{}`
     -> `{revoked:true}` (sessions plus OPDS/KOReader app passwords).
2. AdminUser exposes id, username, display_name, role, locale, disabled,
   created_at and updated_at only. No password/token/hash/session secrets.
   Create accepts username/display_name/password/role/locale (enabled by
   default). PATCH permits username/display_name/role/locale/disabled, with
   omission preserving values. Password is set only through reset.
3. Reuse existing Argon2/password/input policies and uniqueness semantics.
   Strict bounded JSON decoding, unknown-field rejection, positive IDs,
   no silent field truncation, and repository-standard problem responses:
   invalid input 400, unauthenticated 401, non-admin 403, missing user 404,
   duplicate/protected-operation conflicts 409.
4. Guard the last ENABLED administrator against delete, disable or demotion
   atomically on the writer connection, including concurrent requests.
   Reject self-delete/self-disable/self-demote to avoid accidental lockout.
   Self password reset/revoke may succeed but must invalidate the current
   session and be documented for UX8's redirect.
5. Password reset and disable revoke all browser sessions AND app passwords
   transactionally; delete cascades auth/private data and preserves shared
   books/libraries through existing FK policies. Role changes revoke sessions
   so stale privileges cannot survive. Disabled accounts must fail session
   login and OPDS/KOReader authentication, including preexisting credentials.
6. Re-check the acting administrator inside sensitive mutation transactions
   where needed to prevent a revoked/demoted actor racing account changes.
   Prevent password/credential values from appearing in logs or responses.
   Cookie-origin protection applies to every mutation; no self-registration.
7. List deterministically with keyset pagination (username/ID), filter neither
   by client-side privilege guesses nor by exposing all users publicly.
   Preserve CLI account creation/reset through shared safe service helpers
   without changing documented behavior silently.

## Acceptance and validation

Tests cover role/auth/origin rejection, CRUD/disabled login, duplicate names,
password reset and all credential revocation, transaction rollback,
self/last-admin guards including concurrent mutation, account deletion FK
effects, and safe paged DTOs. Run focused auth/HTTP/CLI/OPDS/KOReader tests,
sqlc check, Go build/lint/tests.
Record exact request/response/error examples and auth invalidation behavior
for UX8, and update your own prompt/progress row/log.

## UX8 API hand-off

Implemented without schema, dependency or web changes. The UI remains UX8's
responsibility; W5's existing ID-based library/access workflow is unchanged.

All routes below require a live `pl_session` browser cookie and current admin
role. Basic/app-password authentication cannot authorize them. Every mutation
uses the existing cookie-origin protection. IDs are positive signed 64-bit
integers. JSON bodies are limited to 16 KiB, must be one object, and reject
unknown fields, null fields and invalid types. Errors use
`application/problem+json`; successful responses use JSON.

### Request and response examples

Example user (timestamps are UTC RFC 3339 strings, from stored milliseconds):

```json
{"id":7,"username":"reader","display_name":"Reader","role":"user","locale":"en","disabled":false,"created_at":"2026-11-04T12:00:00Z","updated_at":"2026-11-04T12:00:00Z"}
```

Only these eight fields are exposed; no password/hash/token/session fields.

| Request | Body | Success |
|---|---|---|
| `GET /api/v1/admin/users?limit=50` | none | 200 `{"items":[<AdminUser>],"next_cursor":null}` |
| `POST /api/v1/admin/users` | `{"username":"reader","display_name":"Reader","password":"correct horse battery","role":"user","locale":"en"}` | 201 `{"user":<AdminUser>}` |
| `GET /api/v1/admin/users/7` | none | 200 `{"user":<AdminUser>}` |
| `PATCH /api/v1/admin/users/7` | `{"display_name":"New name","locale":"zh"}` | 200 `{"user":<updated AdminUser>}` |
| `PATCH /api/v1/admin/users/7` | `{"disabled":true}` | 200 `{"user":<disabled AdminUser>}` |
| `DELETE /api/v1/admin/users/7` | none | 200 `{"deleted":true}` |
| `POST /api/v1/admin/users/7/reset-password` | `{"password":"replacement password"}` | 200 `{"reset":true}` |
| `POST /api/v1/admin/users/7/revoke-credentials` | `{}` | 200 `{"revoked":true}` |

`<AdminUser>` above denotes the exact example object, not a string. For example:

```json
{"user":{"id":7,"username":"reader","display_name":"Reader","role":"user","locale":"en","disabled":false,"created_at":"2026-11-04T12:00:00Z","updated_at":"2026-11-04T12:00:00Z"}}
```

- List defaults to 50, maximum 100; explicit limits outside 1-100 are 400.
  Ordering is SQLite `username COLLATE NOCASE`, then ID. Pass the returned opaque
  `next_cursor` unchanged (URL-encoded) as `cursor` for the next page. Exhausted
  pages have `next_cursor:null`; empty lists have `items:[]`. Unknown or repeated
  query parameters and malformed cursors are 400. Pagination is a live keyset,
  not a snapshot: restart the list after renaming/creating/deleting an account.
- Create requires username/password. Display name defaults to empty, role to
  `user`, locale to `en`, disabled to false. Username/display name are trimmed;
  username is 1-64 UTF-8 bytes (no NUL), display name at most 128 bytes.
  Usernames are case-insensitively unique using SQLite's existing NOCASE policy.
  Roles are `admin`/`user`; locales are `en`/`zh`. Passwords are 12-1024 UTF-8
  bytes, not trimmed, and hashed with the existing bounded Argon2id manager.
- PATCH accepts only username/display_name/role/locale/disabled. Omission
  preserves a value; `display_name:""` clears it; `disabled:false` re-enables.
  Empty role/locale and all null values are invalid. An empty object is a
  valid no-op field update. Password changes require the reset route.

### Error examples

```text
401 {"type":"about:blank","title":"Unauthorized","status":401}
403 {"type":"about:blank","title":"Forbidden","status":403}
400 {"type":"about:blank","title":"Bad Request","status":400,"detail":"The user ID must be positive."}
404 {"type":"about:blank","title":"Not Found","status":404,"detail":"The user was not found."}
409 {"type":"about:blank","title":"Conflict","status":409,"detail":"That username is already in use."}
409 {"type":"about:blank","title":"Conflict","status":409,"detail":"cannot delete, disable or demote yourself or the last enabled administrator"}
```

401 means missing/expired/revoked/disabled browser authentication; 403 means a
non-admin or cookie-origin rejection. Malformed JSON, unknown fields, excessive
body/field lengths, bad role/locale/password/limit/cursor are 400. Unexpected
storage failures return a generic 500, never success or internal SQL details.

### Invalidation and deletion

- Password reset, disabling and explicit revocation delete **all sessions and
  both OPDS/KOReader app passwords in the same writer transaction**. Re-enabling
  does not revive credentials. Password reset keeps the account's disabled state.
- Every role change revokes all browser sessions. App passwords remain valid
  after a role change and resolve the current role on authentication.
- Self-delete/disable/demotion and removal of the last enabled admin are 409.
  A disabled admin does not count toward the enabled-admin guard. Guards and
  the acting admin's session/role are rechecked on the serialized writer.
- **UX8 redirect:** self password reset or credential revocation succeeds with
  200, clears the current session cookie, and invalidates every current session.
  Redirect immediately to `/login`; do not attempt a list refresh first.
  Other-account operations keep the acting admin signed in.
- Deletion cascades auth/private data and private shelves. Shared libraries,
  books and shared shelves/membership survive via existing SET NULL policies.
- CLI create retains its flags, secure prompts, first-user-admin and uniqueness
  policies, now with transactional creation. CLI reset shares the safe reset
  helper and intentionally also revokes app passwords; operators must reissue
  device credentials. Login rechecks the verified password hash and enabled
  state before creating a session, so an in-flight old-password login cannot
  survive a reset/disable/delete or overwrite a reset during Argon2 rehash.

### Verification

Passed focused auth/HTTP/app/CLI/OPDS/KOReader tests, `sqlc diff`,
`CGO_ENABLED=0 go build ./cmd/pandalibrary`, `go vet ./...`,
`staticcheck ./...`, and `go test ./...`. Concurrent cross-admin
disable/demote/delete/revoke tests also passed ten repeated runs. Regression
coverage includes strict inputs, safe paged DTOs, actor rechecks, self/last-admin
guards, disabled/old credential rejection, rollback on credential-deletion
failure, login/reset races, FK deletion effects, and self-revocation cookies.
