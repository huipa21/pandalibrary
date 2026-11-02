# ADR-0003: Schema lives in migrations; pending schema and data migrations auto-apply at startup

- Status: Accepted
- Date: 2026-11-02

## Context

The first draft kept the schema in `docs/schema.sql`. A schema in the docs drifts from the
real database as soon as the second migration lands. Users run the server as a single
binary or container and expect an upgrade to be "replace the binary and restart" with no
manual database steps, including data changes (backfills, reshaped JSON, recomputed sort
keys).

## Decision

- The schema is defined only by `internal/db/migrations/` (goose, embedded in the binary).
  `00001_init.sql` is the initial schema. sqlc reads the same folder.
- On every startup the server compares the database version with the embedded migrations.
  If any are pending, it takes a `VACUUM INTO` backup and applies them automatically, each
  in its own transaction, then runs integrity checks and post-migration actions before it
  serves requests.
- Data migrations are first class:
  - set-based changes go in SQL migrations;
  - row-wise changes go in Go migrations with frozen code;
  - slow file-level work goes in resumable background jobs requested by a flag.
- A database newer than the binary makes startup fail. Rollback means restoring the
  pre-migration backup.
- Merged migrations are immutable (`migrations.sum` check). Versions are sequential, and
  only one in-flight task may add a migration.

Full process: [architecture/migrations.md](../architecture/migrations.md).

## Alternatives considered

- Declarative schema diffing (for example Atlas): diffs SQLite well, but data migrations
  and FTS tables still need hand-written steps, and it adds a tool at runtime or in CI.
- Manual `migrate` command only: easy to forget, and it breaks the "replace the binary"
  upgrade.
- Timestamp-versioned migrations: they avoid name clashes between parallel branches but
  need `allow-missing`, which allows the apply order to differ between databases.

## Consequences

- Upgrades are automatic and recoverable, because a backup is taken first.
- Every migration needs tests; data migrations need fixture-based upgrade tests.
- Plan tasks must declare whether they own a migration, so those tasks are serialized.
