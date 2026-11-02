# A1: Authentication vertical slice

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § A1
- Depends on (merged): F4 (and its F2/F3 dependencies)
- Can run in parallel with: none — serial gate
- Branch / worktree: `master`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3–6, 12, 15
- [architecture/database.md](../architecture/database.md) §§1–3, 10
- [architecture/migrations.md](../architecture/migrations.md) §§1–2
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md)
- [ADR-0003](../decisions/0003-auto-applied-migrations.md)
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5
- [progress/README.md](../progress/README.md)
- The merged F4 app, router/middleware, configuration, and CLI
- The F3 API client, Paraglide setup, and SvelteKit routes
- `internal/db/migrations/00001_init.sql` and the generated `internal/db/sqlc` package

## Goal

Deliver the first usable authenticated experience: create the initial administrator
through a one-time setup flow or CLI, log in and out using revocable database-backed
sessions, protect authenticated routes with a typed viewer, and manage per-user OPDS and
KOReader app passwords. Wire the matching login, setup, and profile/app-password screens
into the web shell. This establishes the identity and authorization boundary that C1 and
all later product work will build on.

## Scope

**Owns (create/modify freely):**
- `internal/auth/**`
- `internal/httpapi/auth*.go`
- `internal/db/queries/auth.sql`
- `web/src/routes/(auth)/**` or the existing equivalent route groups for login, setup, and
  settings
- `web/src/routes/+layout.svelte` and directly related auth/layout components and messages
- `cmd/pandalibrary` `user create` and `user reset-password` dispatch/implementation
- Focused tests and fixtures for the above

**Shared files (append-only, see plan §4):**
- `internal/httpapi/routes.go` — mount auth routes via the existing `Mount` convention;
  preserve health, SPA, middleware, and unrelated route behavior
- `internal/app/app.go` — add auth service/router wiring and first-run setup-token handling
  without restructuring unrelated startup/shutdown code
- `internal/db/sqlc/**` — generated output from the auth query file; run `task sqlc`
- `go.mod` / `go.sum` — add only necessary auth dependencies, preserving existing ones
- `web/messages/en.json` and `web/messages/zh.json` — add auth-prefixed keys without
  reordering or rewriting existing messages
- `web/src/lib/nav.ts` — add an auth/settings navigation entry only if needed; preserve
  existing entries
- [progress/README.md](../progress/README.md) — edit only the A1 row and append the A1 log

**Must not touch:**
- `internal/db/migrations/**` — all required auth tables are in the initial migration;
  no schema change is planned
- `internal/db/**` outside `queries/auth.sql` and generated `sqlc` output
- `internal/config/**`, F4 middleware internals, or unrelated CLI commands
- Catalog, reading, importer, OPDS, or KOReader protocol handlers owned by later tasks
- CI, task definitions, or unrelated frontend pages

## Requirements

1. Implement password hashing with argon2id using the exact parameters in system.md §6:
   t=3, m=64 MiB, p=4, 16-byte random salt, 32-byte key, encoded as a valid PHC string.
   Limit concurrent hash/verify work to two operations with a context-aware semaphore.
   Verify PHC parameters safely, rehash after a successful login when parameters change,
   and perform a dummy hash for unknown usernames so the response does not reveal account
   existence by timing. Return errors explicitly; never log passwords, tokens, cookies,
   or app-password secrets.
2. Implement the auth store/service using the existing `users`, `sessions`, and
   `app_passwords` schema and F2 writer/reader pools. Put auth SQL in
   `internal/db/queries/auth.sql`, generate it with sqlc, and keep writes on the writer.
   Store only `sha256` hashes of browser session tokens. Store app-password hashes exactly
   as specified by database.md §3: `sha256(secret)` for OPDS and
   `sha256(lower(hex(md5(secret))))` for KOReader credentials.
3. Implement browser sessions with 32 cryptographically random bytes encoded using
   base64url and a `pl_session` cookie. Set `HttpOnly`, `SameSite=Lax`, and `Path=/`;
   set `Secure` when the configured public base URL is HTTPS. Sessions expire after 30
   days and slide forward; update `last_seen_at`/`expires_at` no more than once per hour.
   Logout deletes the current session and clears the cookie. Password reset and disabling
   a user revoke all that user's sessions. Disabled users cannot log in or authenticate
   using sessions/app passwords.
4. Add a typed `Viewer` in request context and middleware that resolves a valid session,
   checks expiry and disabled status, and rejects unauthenticated requests with the
   repository's `application/problem+json` helper. Provide composable role enforcement
   for later admin-only handlers. Do not trust any identity supplied by request fields or
   headers. Apply F4's cookie-origin protection to unsafe session-authenticated routes.
5. Implement these endpoints under `/api/v1`:
   - `GET /auth/me`: return the current user's safe public profile (`id`, `username`,
     `display_name`, `role`, `locale`); return 401 without a valid session.
   - `POST /auth/login`: accept `{ "username": "...", "password": "..." }`; on success
     set the session cookie and return the same safe profile. Use one generic failure
     response for unknown, disabled, and incorrect-password accounts.
   - `POST /auth/logout`: revoke the current session if present and clear the cookie;
     make repeated logout requests safe.
   - `GET /api/v1/setup`: return whether initial setup is required, without revealing
     account data or the setup token.
   - `POST /api/v1/setup`: accept a setup token and initial admin fields; require the
     token and atomically create the first admin only while `users` is empty. The token
     must not be accepted after setup completes.
   - `GET /me/profile` and `PATCH /me/profile`: authenticated safe-profile read/update
     for display name and supported locale. Validate input and never allow changing role,
     disabled state, username, or user ID through this endpoint.
   - `GET /me/app-passwords`, `POST /me/app-passwords`, and
     `DELETE /me/app-passwords/{id}`: authenticated list/create/revoke scoped to the
     viewer. Creation accepts `kind` (`opds` or `kosync`) and a bounded label. Generate a
     16-character secret from the documented unambiguous 32-symbol alphabet, display it
     once in `xxxx-xxxx-xxxx-xxxx` form, and never return it again. List responses must
     omit secret hashes and secrets.
   Return safe problem responses for invalid input, authentication failure, expired or
   invalid setup tokens, duplicate/finished setup, and missing resources. Never expose
   SQL, hashing, or other internal errors.
6. First-run behavior: when there are no users, generate a cryptographically random
   one-time setup token and log it once at startup at an appropriate level. Do not log it
   when any user exists. Require it for HTTP setup and rotate/invalidate it on restart.
   Rate-limit login and setup using F4's resolved client IP; bound memory/state and return
   an explicit 429 problem response. Do not add a third-party rate-limit service.
7. Implement `pandalibrary user create` and `pandalibrary user reset-password` using the
   same validation and password hashing rules as HTTP auth. `user create` supports an
   explicit admin role for first-run bootstrap. Do not accept passwords as command-line
   arguments or print them; prompt securely and fail clearly when secure input is
   unavailable. Preserve existing behavior for all other commands and invalid arguments.
8. Add web routes for setup and login, and authenticated profile/app-password settings.
   The app shell must check `/auth/me`, render authenticated navigation only for a valid
   viewer, and send unauthenticated users to login without an infinite redirect loop.
   Expose setup only when `GET /api/v1/setup` reports it is required. Support password login,
   logout, profile display-name/locale edits, and app-password create/list/revoke; show
   a newly created secret once with an explicit copy/save warning. Use the existing typed
   API client, Paraglide messages (English and Chinese), styling conventions, and
   accessible labels/error states.
9. Add tests for PHC hash/verify, dummy-user path, parameter rehash, semaphore/context
   cancellation, session expiry/sliding/revocation, disabled-user rejection, secure cookie
   attributes, setup token and race-safe first-admin creation, login/setup rate limits,
   viewer/role middleware, app-password secret generation/hash/list/revoke behavior,
   CLI secure-input/error paths, and HTTP responses. Use temporary migrated databases and
   `httptest`; do not bind fixed ports. Add focused frontend tests and a Playwright flow
   covering setup → login → me → logout and app-password create/revoke.
10. Do not add an auth schema migration. Preserve F4 health and SPA behavior and the
    existing generic router middleware order. Update architecture documentation or add
    an ADR only if implementation requires a genuine design change; note any changed API
    shape or follow-up needed by C1.

## Out of scope

- User/library/catalog administration UI beyond the current user's profile and app
  passwords (C1/W5)
- Catalog tables, visibility rules, book handlers, and library creation
- OPDS Basic authentication or KOReader protocol endpoints (O1/K1); expose reusable
  credential-verification helpers for those tasks
- Reading settings/sync APIs owned by R1
- Password-reset email, public registration, external identity providers, and MFA

## Acceptance criteria

- [x] First-run setup creates exactly one admin; setup is disabled afterward and the CLI
  can create/reset users without exposing passwords in arguments or output.
- [x] Setup → login → `/auth/me` → logout works with database-backed, revocable sessions;
  disabled users and expired/revoked sessions are rejected.
- [x] Viewer and role middleware compose with F4's router mount and cookie-protection
  conventions; login/setup rate limits are bounded and tested.
- [x] App passwords are generated once, stored only as the schema-prescribed hashes, and
  can be listed/revoked only by their owner.
- [x] Login, setup, profile, and app-password UI works in English and Chinese; Playwright
  covers setup/login/me/logout and app-password lifecycle.
- [x] `task sqlc` produces current generated output and `task sqlc:check` is clean.
- [x] `task web:check`, `task web:test`, `task web:build`, `task lint`, and `task test`
  pass from the repository root.
- [x] No migration or unrelated product/API behavior is changed.

## Validation commands

```powershell
task sqlc
task sqlc:check
task web:check
task web:test
task web:build
task lint
task test
```

Run the focused Playwright login/setup test using the repository's existing browser-test
workflow; do not make browser installation a dependency of `task web:test`.

## Hand-off

- Set this prompt's status to `Done`, and update only the A1 row and append an A1 entry in
  [progress/README.md](../progress/README.md).
- Update architecture docs or add an ADR if the implementation changed the accepted
  authentication design. Record API shapes and follow-ups for C1 and later auth consumers.
