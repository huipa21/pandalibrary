# UX7: Administrator account lifecycle API

- Status: Ready
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
