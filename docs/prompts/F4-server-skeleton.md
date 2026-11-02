# F4: Server skeleton

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § F4
- Depends on (merged): F2, F3
- Can run in parallel with: none — serial gate
- Branch / worktree: `task/f4` in `..\pandalibrary-f4`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§2–6, 14–15
- [architecture/database.md](../architecture/database.md) §1
- [architecture/migrations.md](../architecture/migrations.md) §§1–2
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md)
- [ADR-0003](../decisions/0003-auto-applied-migrations.md)
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5
- [progress/README.md](../progress/README.md)
- The merged F2 database/migration APIs, F1 CLI dispatch, and F3 `webui.Files` embed

## Goal

Turn the existing CLI, database/migration runner, and embedded SPA into a runnable
single-process server foundation. It must load and validate runtime configuration,
run migrations before serving, expose a tested health endpoint and route-mounting
convention, serve the SPA with deep-link fallback, and shut down cleanly. This is
infrastructure only; authentication, product APIs, and scheduled product work belong
to later tasks.

## Scope

**Owns (create/modify freely):**
- `internal/config/**`
- `internal/app/**`
- `internal/httpapi/**`
- `internal/jobs/**` (scheduler only)
- `cmd/pandalibrary` `serve` and `healthcheck` dispatch and implementation

**Shared files (append-only, see plan §4):**
- `go.mod` / `go.sum` — add chi and the HTML tokenizer needed to nonce the embedded
  SvelteKit bootstrap safely

**Must not touch:**
- `internal/db/**` or `internal/db/migrations/**` — use F2 APIs; `Migration: no`
- `web/**` — use the existing F3 embed package and SPA output
- `internal/auth/**` or product service packages — owned by later tasks
- `.github/workflows/ci.yml`, `Taskfile.yml`, or unrelated CLI commands
- `docs/architecture/` or `docs/decisions/` unless implementation reveals a genuine
  design inconsistency; report it rather than silently changing the design

## Requirements

1. Implement typed configuration loading and validation for the server settings used
   by this task: `PANDA_DATA_DIR` (default `/data`), `PANDA_LISTEN` (default `:8080`),
   `PANDA_DROP_DIR` (default `<data-dir>/drop`), optional `PANDA_BASE_URL`,
   `PANDA_TRUSTED_PROXIES` CIDRs, `PANDA_MAX_UPLOAD_MB` (default `1024`), and
   `PANDA_LOG_LEVEL` (default `info`). Support corresponding command-line flags for
   `serve`; reject malformed values explicitly, including non-positive or overflowing
   upload limits. Keep migration settings under the existing F2 runner's ownership.
2. Wire startup through `internal/app`: open the F2 database at
   `<data-dir>/pandalibrary.db`, create the runtime directories from system.md §4
   (`files`, `covers`, `tmp`, and `backups`) plus the configured drop directory, create a
   migration runner with `migrations.DefaultOptions()` and the embedded migration files,
   and call `Run` before accepting HTTP traffic. Pass cancellation through startup and
   return contextual errors; close all opened resources if a later startup step fails.
3. Implement `serve` as the default command as well as an explicit subcommand. Preserve
   F1/F2 behavior for `migrate` and `user`; do not turn unimplemented commands into
   success. Run the HTTP server with a signal-aware context, sensible header/idle
   timeouts, and graceful shutdown with a bounded timeout. Stop the scheduler and close
   both database pools during shutdown, surfacing shutdown/close errors.
4. Add a health handler at `GET /healthz`. It returns success only after startup
   migrations/actions have completed and the database can be pinged; otherwise return
   `503 Service Unavailable` without exposing internal error details. Keep it
   unauthenticated. Implement `healthcheck` as a bounded-time probe of the configured
   local listener's `/healthz`; it must exit non-zero if the request fails or does not
   return success, and must not probe `PANDA_BASE_URL`.
5. Build the `httpapi` router with chi and a `Mount` convention that lets later domain
   packages register routes without modifying unrelated handlers. Mount only the
   health and SPA routes in this task. Return `404` for unmounted `/api/`, `/opds/`, and
   `/kosync/` paths rather than serving the SPA for them.
6. Serve assets from `webui.Files` using the `build` subtree. Serve existing assets with
   their correct content types; serve the embedded `index.html` as the fallback for
   unknown browser `GET`/`HEAD` routes so client-side deep links work. Do not fallback
   for non-GET/HEAD methods or reserved API/protocol paths. Give
   `/_app/immutable/*` assets a one-year immutable cache policy and avoid caching the
   SPA fallback as immutable.
7. Implement the documented middleware foundations in this order where applicable:
   request ID, structured `slog` logging, panic recovery, trusted-proxy-aware client IP,
   security headers/CSP, request-body size limiting, and `http.CrossOriginProtection`
   for unsafe cookie-authenticated routes. Do not trust forwarded headers from
   untrusted peers. Use the CSP in system.md §6; nonce the embedded SPA's inline
   bootstrap per response without enabling arbitrary inline scripts. Do not log
   cookies, authorization headers, or other credentials. Keep middleware composable
   for the auth task's route-specific middleware and rate limiting.
8. Use a consistent `application/problem+json` response helper for HTTP errors. Include
   the HTTP status and a safe public title/detail; never return raw internal errors to
   clients. Ensure panic recovery also produces a generic 500 response and does not
   write a second response if headers have already been sent.
9. Implement only a scheduler foundation in `internal/jobs`: allow registering
   context-bound periodic work and stop it on cancellation. Do not add product jobs or
   start empty background goroutines unnecessarily.
10. Add tests for configuration defaults and invalid values; migration-before-listen
   startup and cleanup on failure; readiness and database ping behavior; healthcheck
   success/failure; SPA assets, deep links, reserved paths, and cache headers; problem
   responses and middleware behavior (including trusted forwarded headers and recovery);
   and scheduler cancellation. Use temporary directories/databases and `httptest`; do not
   depend on a fixed port.
11. Keep dependencies minimal and use the existing F2/F3 APIs rather than duplicating
   database, migration, or embed logic. Update root README commands/prerequisites only
   if the existing scaffold documentation is now inaccurate.

## Out of scope

- Authentication, setup, user management, sessions, authorization, or rate limiting
  (A1)
- API handlers for catalog, reading, search, OPDS, or KOReader
- Importer, drop-folder watcher, or actual maintenance jobs
- New database schema or migration files
- Docker or release packaging (Q1)

## Acceptance criteria

- [x] `pandalibrary` and `pandalibrary serve` start the same server; migrations complete
  before the listener serves requests.
- [x] Configuration defaults and invalid settings are covered by tests.
- [x] `/healthz` reflects startup readiness and database availability; `healthcheck`
  accurately reports the local endpoint's status.
- [x] The embedded SPA serves assets and deep links with the specified fallback and
  caching behavior, while reserved API/protocol paths return 404.
- [x] Middleware, problem responses, graceful shutdown, and scheduler cancellation have
  focused tests.
- [x] `task build`, `task lint`, and `task test` pass after `task web:build`.
- [x] Existing migrate/user command behavior is preserved; no migration or feature
  implementation is added.

Validation: the listed tasks and `task sqlc:check` passed on Windows; focused F4 race
tests passed under Linux. A live binary passed healthcheck, migration status, HTTP
fallback/error checks, and a browser load without console errors.

## Validation commands

```powershell
task web:build
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and F4's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record integration notes for A1, especially route mounting, cookie-route middleware,
  configuration access, and app lifecycle.
- Update architecture docs or add an ADR only if the accepted design changes.

A1 can add `httpapi.Mount` callbacks in the app's router wiring and apply the supplied
cookie-protection middleware to session routes. `config.Config` holds runtime settings;
the app initializes migrations before listening and owns scheduler/database shutdown.
Use `httpapi.ClientIP` and `httpapi.RequestScheme` instead of raw forwarded headers.
