# I1: Importer

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § I1
- Depends on (merged): C1, X1, X2, X3
- Can run in parallel with: W2, S1, SH1
- Branch / worktree: `task/i1` in `..\pandalibrary-i1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3–7, 15–16
- [architecture/database.md](../architecture/database.md) §§1–5, 7–9
- [architecture/migrations.md](../architecture/migrations.md) §§1–2
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0003](../decisions/0003-auto-applied-migrations.md), and
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- The merged catalog service and generated sqlc package; X1 registry/sniffer and common
  metadata contract; X2/X3 extractors; `internal/blobstore/`, `internal/covers/`,
  `internal/db/db.go`, `internal/jobs/`, and current application/router wiring

## Goal

Implement a durable, bounded import pipeline for administrator uploads and the configured
drop directory. Stream files to temporary storage while hashing, detect duplicates, extract
metadata/covers through the merged registry, commit each new book atomically, and expose
useful job status while workers and the watcher stop cleanly with the server.

## Scope

**Owns (create/modify freely):**
- `internal/importer/**`
- The blobstore write side under `internal/blobstore/`; preserve C1's existing read APIs
- `internal/db/queries/import.sql` and generated sqlc output from `task sqlc`
- Upload/import HTTP handlers and tests under `internal/httpapi/`
- `internal/config/config.go` and focused tests only for the documented optional
  `PANDA_DROP_POLL` fallback setting

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — construct the importer, register its mount, and integrate its
  worker/watcher lifecycle without changing existing service behavior
- `internal/httpapi/routes.go` — only if the existing route architecture actually requires
  a registration change; follow current `httpapi.Mount` patterns
- `go.mod` / `go.sum` — add dependencies only when required
- `README.md` — document the supported drop-poll setting if it is added
- [progress/README.md](../progress/README.md) — edit only the I1 row and append an I1 log

**Must not touch:**
- Migrations, catalog APIs/DTOs, extractor/sniffer implementations, cover normalization,
  or catalog metadata editing
- Search query behavior or shelves implementation (S1/SH1)
- W5 admin UI or K1/ J1 background domain features

## Requirements

1. Register the merged EPUB, PDF, MOBI, AZW3, FB2, FBZ, and CBZ extractors with one
   `extract.Registry`. Do not modify the X1 sniffer or extractor packages. X3 currently
   records a known plain-FB2 sniffing blocker; retain it as an explicit follow-up rather
   than masking it or claiming that dispatch works. Test every registry format that is
   currently dispatchable and document the blocked plain-FB2 case in the hand-off.
2. Extend `blobstore.Store` with safe content-addressed write operations for book blobs.
   Stream into a unique file under `tmp/`, compute SHA-256, byte size, and KOReader partial
   MD5 in one pass, sync and close it, then publish atomically under `files/<prefix>/`.
   Validate format/hash keys, never use user-controlled paths, do not replace a different
   existing blob, and clean up temporary files on every error path. Preserve the existing
   read-side behavior.
3. Implement `POST /api/v1/uploads` as an administrator-only multipart upload with
   `library_id` and one `file`; stream rather than buffering the whole request in memory.
   Validate the target library through the catalog service and enforce the router's
   configured request-size limit. Return `202 Accepted` with the created job. Implement
   `POST /api/v1/books/{id}/files` for adding another format to a visible book, and
   `GET /api/v1/imports` for an administrator's bounded job history. Use problem responses
   and the existing auth/session, cookie-protection, and HTTP error-mapping conventions.
4. Treat `import_jobs` as the durable queue and history. Persist a pending job before
   enqueueing work; resume pending/processing rows on startup. Use a bounded two-worker
   pool, mark transitions and final outcomes in the database, and avoid losing work when
   an in-memory queue is full or the process restarts. Validate IDs, body parts, file names,
   and multipart errors explicitly.
5. For each job, hash and sniff the content, check for an existing `book_files.sha256`,
   and report duplicates with `duplicate_of_book_id` without creating another book. Repeat
   the duplicate check inside the final write transaction to cover concurrent imports.
   Extract metadata with the registry's timeout/recovery behavior; normalize extracted
   covers through `covers.Normalize`; write the blob before the database transaction so a
   crash can leave only an orphan for normal cleanup.
6. In one write transaction for a new book, create the book, ordered authors and roles,
   series/index, tags, identifiers, file row, field-source rows, and FTS document. Use
   `catalog.SortTitle` and `search.IndexBook` rather than duplicating their behavior. The
   file row must preserve the original display name, safe format, size, SHA-256, and
   KOReader digest. Fall back to a cleaned filename for a missing title. Keep all slow
   reads, extraction, image processing, and filesystem work outside the transaction.
7. Implement the drop-folder watcher for `drop/` and each `drop/<library-slug>/`, with
   fsnotify, a 3-second size/mtime stability check, startup scan, and the documented
   optional polling fallback. Root files use `server_settings.default_library_id`;
   subfolder slugs resolve to libraries. Ignore hidden names, directories other than
   configured library folders, and `*.part`, `*.crdownload`, and `*.tmp`. Do not follow
   symlinks or allow a path to escape the configured drop root.
8. On success, delete a drop-folder source only after the book transaction commits. Move
   duplicates to `.duplicates/`; move failures to `.failed/` and write a bounded,
   sanitized `<name>.error.txt`. Upload sources are temporary and are cleaned up after
   processing. Report filesystem and database errors explicitly; log failures with job IDs
   and keep the server running.
9. Integrate importer workers and watcher with application startup and graceful shutdown.
   Cancellation must stop accepting new work, unblock workers, wait within the existing
   shutdown budget, and close filesystem/database resources. Add `PANDA_DROP_POLL` parsing
   and validation only as required for the fallback; zero keeps polling disabled.
10. Add tests for streaming/size limits, all supported registry formats, corrupt inputs,
    duplicate detection including concurrent duplicate imports, transaction rollback,
    cover publication, upload authorization, durable job recovery, watcher debounce and
    startup scan, ignored files, `.duplicates`/`.failed` outcomes, and cancellation. Do not
    weaken any test to hide the X1 plain-FB2 blocker.

## Out of scope

- Format extraction/sniffing fixes (X1/X2/X3); report the X3 blocker for its owner
- Metadata providers, metadata merge workflow, and admin UI (M1/W5)
- Maintenance retention/orphan sweeps (J1) and KOReader protocol integration (K1)
- Search query endpoint (S1); only maintain the FTS row through `search.IndexBook`

## Acceptance criteria

- [x] Uploading and dropping an EPUB create a searchable book and a completed import job.
- [x] A duplicate is reported without creating a second book.
- [x] A corrupt drop file reaches `.failed/` with a bounded error file.
- [x] Workers recover queued jobs after restart and stop cleanly on shutdown.
- [x] Uploads and drop paths are bounded and cannot escape their configured roots.
- [x] Supported format tests use the registry; the known X3 plain-FB2 blocker remains
  explicit and is not worked around in X1 code.
- [x] `task sqlc:check`, `task build`, `task lint`, and `task test` pass.

## Validation commands

```powershell
task sqlc:check
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and I1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record the upload/job contract and any importer lifecycle API used by J1 and W5.
- Report the X3 plain-FB2 sniffing blocker without changing its owner files.
- Update architecture docs or add an ADR only if the accepted design changes.

### Implemented contract (2026-11-03)

- `POST /api/v1/uploads`: administrator session and cookie-origin protection; multipart
  `library_id` (positive integer text) and exactly one `file`, in either order. The entire
  request is bounded by the router limit, including requests without Content-Length.
  Unknown/repeated parts, empty files, malformed multipart data, and unsafe display names
  are rejected. Returns `202` with `{"job": {...}}` after persisting the pending job.
- `POST /api/v1/books/{id}/files`: same protections, multipart `file` only; the library
  comes from the visible target book. Attachment adds the file without replacing existing
  metadata. The final transaction rechecks the target library and the administrator's
  hide list. Global SHA-256 duplicates return a duplicate job rather than another file.
- `GET /api/v1/imports`: administrator-only, newest IDs first; `limit` is 1-100 (default
  50), and `cursor` is the positive ID returned in `next_cursor`. Response is
  `{"items": [...], "next_cursor": "<id>" | null}`. Jobs expose `id`, `source`,
  `library_id`, nullable `user_id`, `original_name`, nullable `sha256`, `status`, nullable
  `error`, `book_id`, `duplicate_of_book_id`, `created_at`, and `finished_at`. Timestamps
  are UTC RFC3339; unfinished jobs have a null finish time. Statuses are `pending`,
  `processing`, `imported`, `duplicate`, and `failed`.
- `importer.New(Options)` constructs without starting goroutines. `Start(ctx)` is
  single-use and starts exactly two SQLite-claiming workers plus the watcher. There is
  no lossy in-memory work queue. `Stop(ctx)` stops intake, cancels workers/watcher, and
  waits within the caller's shutdown budget; interrupted processing jobs remain
  recoverable. The database is closed only after the importer stops.
- Synced `tmp/imports/<job-id>.json` manifests retain the staged token, attachment target,
  and drop-source snapshot without a migration. The manifest is written before the job
  creation transaction commits. Startup resets processing rows and also retries terminal
  filesystem cleanup. J1 must treat manifests and their referenced staged files as live
  until processing and cleanup finish; `tmp/` is not wholly disposable request cache.
- Drop inputs stabilize for three seconds; root files use `default_library_id`, and
  configured library slugs select subfolders. The watcher does not follow symlinks.
  Imported sources are removed after commit. Archives use collision-safe
  `.duplicates/<job-id>-<name>` and `.failed/<job-id>-<name>` names (archive basename
  truncated to 180 bytes); failures have a sanitized, at-most-2049-byte `.error.txt`.
  Replaced sources are preserved and reconsidered rather than deleted.
- `PANDA_DROP_POLL` / `--drop-poll` accepts `0` (disabled) or a Go duration of at least
  `1s`, for example `5s`. Polling supplements fsnotify and permits startup without
  fsnotify when the backend is unavailable.
- EPUB, PDF, MOBI, AZW3, UTF-8 FB2 without a BOM, FBZ, and CBZ all have registry dispatch
  coverage. **Known X1/X3 follow-up:** Windows-1251 plain FB2 and UTF-8 plain FB2 with a
  BOM still fail before reaching their extractor. Importer tests explicitly retain this
  limitation; no sniffer or extractor changes were made.
- Validation passed: `task sqlc:check`, `task build`, `task lint`, and `task test`.
  Tests cover real SQLite rollback/FTS, cover publication, a forced concurrent duplicate
  race, active-job cancellation/recovery, startup/live fsnotify and polling-only scans,
  debounce, ignored/unsafe paths, terminal cleanup recovery, multipart streaming limits,
  authorization, history, and attachment visibility changes.
