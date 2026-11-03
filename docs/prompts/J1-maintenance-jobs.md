# J1: Maintenance jobs

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § J1
- Depends on (merged): I1, R1
- Can run in parallel with: W3, K1, M1
- Branch / worktree: `task/j1` in `..\pandalibrary-j1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3–4, 7, 10, 13–16
- [architecture/database.md](../architecture/database.md) §§1–2, 5–6, 8–9
- [architecture/migrations.md](../architecture/migrations.md) §§1–2
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0003](../decisions/0003-auto-applied-migrations.md), and
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- The merged `internal/jobs/` scheduler, `internal/app/app.go` lifecycle, I1 importer and
  blobstore paths, R1 tombstones, database pools/schema, and current admin HTTP patterns

## Goal

Register safe, bounded maintenance tasks with the existing scheduler and expose
administrator-only maintenance controls. Clean expired state, create retained online
backups, remove only confirmed orphan files, and surface job errors without disrupting
serving or importer work.

## Scope

**Owns (create/modify freely):**
- Maintenance task implementations and tests under `internal/jobs/`; preserve the existing
  scheduler lifecycle and public behavior
- Admin maintenance handlers and tests under `internal/httpapi/`
- Focused maintenance helpers/tests under `internal/blobstore/` only if existing APIs
  cannot safely perform the required orphan scan

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — register tasks before scheduler start and add maintenance mount
  wiring without refactoring existing service lifecycle
- `internal/httpapi/routes.go` — add one mount registration line only
- `go.mod` / `go.sum` — add dependencies only when required
- [progress/README.md](../progress/README.md) — edit only the J1 row and append a J1 log

**Must not touch:**
- Migrations, importer queue semantics, reading sync rules, or the F4 scheduler lifecycle
- W3/K1/M1 implementation paths or any external task's progress row
- Book blobs, covers, or import spool data without proving they are unreferenced and safe
  to remove

## Requirements

1. Register periodic tasks using the existing `jobs.Scheduler`; no task may start before
   registration, run after cancellation, or block graceful shutdown indefinitely. Use
   context-aware bounded database/filesystem operations and rely on scheduler logging for
   surfaced failures. Do not silently convert errors into success.
2. Implement hourly cleanup for expired login sessions, expired `metadata_cache` rows,
   `import_jobs` older than 30 days, and sync tombstones older than 180 days. Use the
   schema's millisecond UTC timestamps and preserve the sync-counter/rev and referential
   integrity invariants.
3. Implement a daily online SQLite backup with `VACUUM INTO` under the configured data
   directory's `backups/`. Use unique safe filenames, never overwrite a previous backup,
   verify completion before retention cleanup, and keep the latest seven successful daily
   backups. Keep path handling safe and report disk/SQLite errors. Do not copy a live DB
   file or its WAL/SHM files as a substitute.
4. Implement a conservative orphan sweep for content-addressed book blobs and covers.
   Compare files with database references, use the existing blobstore layout, and apply a
   documented grace period so a just-published file or concurrent import is not removed.
   Never follow symlinks, leave the drop folder and active importer temp/spool files alone,
   and restrict deletion to resolved descendants of the configured storage roots.
5. Run `PRAGMA optimize` with the daily maintenance work and a passive WAL checkpoint every
   five minutes. Run an FTS consistency check using the existing schema/SQLite-supported
   command. Report detected inconsistency; do not silently rebuild or delete user data.
6. Expose a minimal administrator-only maintenance API using the existing auth, cookie
   protection, problem-response, and `httpapi.Mount` conventions. It must report supported
   jobs and allow an administrator to request an on-demand run without permitting
   overlapping runs of the same job. Return explicit accepted/completed/error status and
   do not expose filesystem paths or database internals. Document the route and DTO
   contract for the later admin UI.
7. Add tests for expiry boundaries, tombstone retention, backup destination/retention and
   failure handling, orphan references/grace periods/symlinks, passive checkpoint,
   FTS-check reporting, admin authorization, overlapping/manual runs, and cancellation.
   Tests must use temporary migrated databases and isolated filesystem roots.

## Out of scope

- Import worker recovery or changes to I1's spool/job state machine
- User-triggered restore, destructive database repair, or arbitrary filesystem actions
- New scheduler framework, migration, or user-facing admin UI

## Acceptance criteria

- [x] Hourly cleanup, daily backup/orphan/optimize work, and five-minute checkpoint are
  registered with the existing scheduler and stop safely on shutdown.
- [x] Tombstones older than 180 days and import history older than 30 days are pruned;
  backups keep the seven newest successful daily snapshots.
- [x] Orphan cleanup cannot remove referenced, recent, active, or out-of-root files.
- [x] FTS inconsistencies and all maintenance failures are surfaced, not silently repaired.
- [x] Admin-only API reports jobs and prevents concurrent duplicate manual runs.
- [x] Focused database/filesystem/HTTP/cancellation tests pass with
  `task sqlc:check`, `task build`, `task lint`, and `task test`.

## Validation commands

```powershell
task sqlc:check
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and the J1 row and dated log entry in
  [progress/README.md](../progress/README.md).
- Document backup retention, orphan grace period, task schedules, and the maintenance
  route/DTO contract for W5. Update architecture docs or add an ADR only if the accepted
  design changes.

### Implemented contract

- Registered jobs: `cleanup-expired` hourly; `backup`, `orphan-sweep`, `optimize`, and
  `fts-check` every 24 hours; `wal-checkpoint` every five minutes. Each has a five-minute
  deadline. Scheduled and manual runs share per-job exclusion; shutdown cancels and waits
  for accepted runs before closing the database.
- Expiry is inclusive (`expires_at <= now`); history/tombstone age is strictly greater
  than 30/180 days. Pending/processing imports are never pruned. Completed imports with
  an existing spool manifest and the highest job ID are retained: the former remains
  recoverable, and the latter prevents `INTEGER PRIMARY KEY` ID reuse. Up to 1,000 history
  candidates are considered hourly. Highlights with surviving child notes are retained
  until the children expire. Sync revisions/counter are not changed.
- Verified online backups have unique `maintenance-<UTC timestamp>-<random>.db` names
  under `backups/`; private `.partial` files are excluded from retention and removed on
  failure. `VACUUM INTO`, `quick_check`, and disk sync complete before no-overwrite
  publication and seven-snapshot retention. Pre-migration/unrelated files are untouched.
- Orphans require a valid storage-layout filename, an mtime strictly older than 24 hours,
  and no database or active-import reference, rechecked under the writer lock. Covers
  are preserved while any import is pending/processing. Rooted directory handles reject
  symlink roots, skip symlink shards/files, and bound deletion to validated shards.
  `tmp/` and drop inputs are never swept; roots overlapping a custom drop path are
  skipped with a warning. Each sweep inspects at most 100,000 files and removes at most
  1,000; failures are surfaced even after partial progress.
- Blobstore publication and orphan removal share a cancellation-aware guard. Reusing an
  old cover refreshes both variants' mtimes under the guard, restarting their grace before
  the catalog reference is committed. A regression test covers an earlier orphan scan
  selecting a subsequently republished cover.
- FTS5 `integrity-check` runs against all three indexes without repair. WAL checkpoints
  are passive and do not wait for active read snapshots.
- W5 API: `GET /api/v1/admin/maintenance` returns
  `{"jobs":[{"name","schedule","status","last_run"}]}`. `last_run` is null before a run;
  otherwise it contains `id`, `status`, `accepted_at`, and optional `started_at` /
  `completed_at` (UTC timestamps). Statuses are `idle`, `accepted`, `running`,
  `completed`, and `error`. `POST /api/v1/admin/maintenance/{job}` has no request DTO and
  returns `202 {"run":{...}}`; poll GET for completion. Unknown jobs return 404,
  overlapping runs 409, and stopped maintenance 503. Both require admin cookie sessions,
  with origin protection on POST. No paths or SQL errors appear in these DTOs; status
  resets on restart and detailed failures are logged.
- Validation: focused blobstore/jobs/HTTP/application tests, five repeated blobstore/job
  runs, targeted vet/staticcheck, and `task sqlc:check`, `task build`, `task lint`, and
  `task test` pass. The two dedicated symlink tests skip on this Windows host because
  symlink creation requires unavailable privileges; they run where supported.
  No K1/M1/W3 implementation files were changed by J1.
