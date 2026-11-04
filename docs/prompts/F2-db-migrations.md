# F2: Database and migration runner

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § F2
- Depends on (merged): F1
- Can run in parallel with: F3, X1
- Branch / worktree: `task/f2` in `..\pandalibrary-f2`
- Migration: yes (migration tooling and `migrations.sum`; no new schema)

## Read first

- [architecture/database.md](../architecture/database.md) §§1–3, 6–10
- [architecture/migrations.md](../architecture/migrations.md) §§1–7
- [architecture/system.md](../architecture/system.md) §§4, 14–15
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md)
- [ADR-0003](../decisions/0003-auto-applied-migrations.md)
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5
- [progress/README.md](../progress/README.md)
- The merged F1 module, CLI dispatch, and Taskfile

## Goal

Implement PandaLibrary's pure-Go SQLite database layer and embedded goose migration
runner. The runner must initialize and safely upgrade the database described by the
existing initial migration, expose operator migration commands, and provide the
database primitives later service and server tasks depend on.

## Scope

**Owns (create/modify freely):**
- `internal/db/**`
- `sqlc.yaml`
- `Taskfile.yml` targets for `sqlc` and `migrate:*`
- The existing `cmd/pandalibrary` migration dispatch/stub, only as needed to wire the
  real `migrate` subcommands into F1's CLI

**Shared files (append-only, see plan §4):**
- `go.mod` / `go.sum` — add only required dependencies; preserve F1 dependencies
- `Taskfile.yml` — preserve F1 tasks and add the database targets

**Must not touch:**
- `internal/db/migrations/00001_init.sql` — the initial schema is already defined and
  must remain unchanged
- Any new application schema migration; this task creates tooling, not schema
- `web/`, `docs/architecture/`, `docs/decisions/`, or unrelated CLI commands

## Requirements

1. Use the pure-Go `modernc.org/sqlite` driver and the goose provider approach in the
   architecture. Pin versions consistently with the project toolchain and use the
   existing migration as the sole schema source.
2. Implement separate writer and reader `*sql.DB` handles for the same database:
   writer pool has one open connection and immediate transaction locking; reader pool
   has at least four connections (or `NumCPU`, whichever is greater) and is query-only.
   Apply the documented WAL, synchronous, foreign-key, busy-timeout, temp-store, and
   cache-size pragmas to every applicable connection. Close both handles and surface
   open/configuration errors.
3. Provide the planned transaction helper and `NextRev` primitive. Keep write
   transactions on the writer and ensure transaction errors are returned rather than
   hidden.
4. Embed SQL migrations in the binary, register Go migrations explicitly, and implement
   the migration runner. It must:
   - initialize an empty database from `00001_init.sql`;
   - reject a database newer than the binary;
   - apply pending migrations in order, one transaction per migration;
   - honor `PANDA_AUTO_MIGRATE` (default true);
   - take a `VACUUM INTO` pre-migration backup when enabled by
     `PANDA_MIGRATE_BACKUP` (default true), except for an empty database;
   - run `foreign_key_check` and `quick_check` after migrations;
   - preserve the documented backup path in errors/logging when an upgrade fails;
   - expose a post-migration action hook that does not clear pending flags unless the
     registered action succeeds.
5. Add `migrations.sum` and verify migration immutability and contiguous sequential
   versions. Do not edit the existing migration to make tooling pass.
6. Implement `pandalibrary migrate status`, `migrate up`, and `migrate down-to <v>` using
   the existing CLI conventions. `down-to` is for development; return clear errors for
   malformed or unsupported arguments.
7. Configure sqlc against `internal/db/migrations` and `internal/db/queries`, generating
   package `sqlc` under `internal/db/sqlc` with the database design's output options.
   Add portable Taskfile targets for generation, diff/check, migration status/up/down,
   migration creation, and sum generation. Preserve existing build/lint/test tasks and
   avoid shell-specific command chaining.
8. Add tests for the migration behaviors in [migrations.md](../architecture/migrations.md)
   §5, including:
   - applying the initial migration to an empty database and checking integrity;
   - down-to-zero/up behavior;
   - sum verification and contiguous versions;
   - upgrading a temporary test database with a fake `00002` migration and creating a
     backup;
   - refusing a database at version 99;
   - auto-migration disabled and backup disabled behavior;
   - writer/reader pragmas and `NextRev`.
   Temporary migrations and databases belong in test temp directories, not the
   repository's migration history.
9. Keep the migration runner usable by F4 without coupling it to HTTP or app packages.
   Document the API and any configuration assumptions in Go doc comments where useful.

## Out of scope

- Adding or changing schema tables, query areas, or application services
- Database-backed auth/catalog/reading behavior
- Web scaffold or frontend work
- Server startup wiring beyond the database/migration API that F4 will call

## Acceptance criteria

- [x] An empty data directory migrates to the latest version; a database at version 99
  is explicitly refused.
- [x] A test-only `00002` migration auto-applies with a pre-migration backup; disabling
  auto-migration or backups has the documented effect.
- [x] Writer and reader pools use the documented settings, and transaction/revision
  tests pass.
- [x] `task sqlc` generates code without modifying the schema, and the sqlc diff/check
  reports a clean state.
- [x] `task build`, `task lint`, and `task test` pass from the repository root.
- [x] No merged migration is modified and no application schema migration is added.

## Validation commands

```powershell
task sqlc
task sqlc:check
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and F2's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record any integration notes for F4, especially the runner startup API and how
  post-migration actions are registered.
- Update architecture docs or add an ADR only if the accepted design changes.
