# Bookheap

The bookheap is an admin-only staging area for books that are not yet in a
library. Files physically live in a configurable folder; the database keeps an
index of them in `bookheap_items`. Heap items are not books: they never appear
in the catalog, search, OPDS, stats, shelves or reading APIs. Assignment to a
library (through the importer) is BH2; the UI is BH3/BH4. The product decisions
and the binding API contract are in the [bookheap plan](../plans/bookheap-plan.md).

Code: `internal/bookheap` (service), `internal/httpapi/bookheap.go` (HTTP),
`internal/db/queries/bookheap.sql`, migration `00004_bookheap.sql`.

## Folder rules

- `--bookheap-dir` / `PANDA_BOOKHEAP_DIR`, default `<data-dir>/bookheap`. The
  path is made absolute and created at startup (`0750`).
- Validation (`config.ValidateBookheapDir`, run at parse time and again after
  the directories exist so symlinks resolve): the heap must not equal or
  contain the data directory, and must not equal, contain or be inside the
  drop directory or `<data>/files`, `covers`, `tmp`, `backups`. Being inside
  the data directory (the default) is allowed.
- The maintenance orphan sweep registers the heap with
  `Maintenance.GuardDirectory` and skips any storage root that overlaps it,
  like the drop-directory guard.
- Admins may copy files into the folder directly and run a scan. Files the
  server writes (uploads) are visible names; temporary uploads are
  `.upload-<random>.part` in the heap root and are always removed.

## Data model

`bookheap_items` (Unix-ms timestamps): `rel_path` (unique, slash-separated,
relative to the heap root), `file_name`, `size_bytes`, `mtime_ns`, `sha256`
(NULL only for unreadable files), `format`, `title` (file-name fallback),
`authors` (JSON array), `language`, `series`, `series_index`, `cover_sha256`
(cover blob in `covers/`), `source` (`upload`/`scan`), `status`, `error`,
`duplicate_of_book_id`, `duplicate_of_item_id`, `target_library_id`,
`target_shelf_ids` (JSON array), `import_job_id`, `added_by`, `created_at`,
`updated_at`. Foreign keys use `ON DELETE SET NULL`.

Statuses: `ready`, `duplicate` (hash matches a library file or an earlier heap
item), `invalid` (unsupported/corrupt/unreadable content), `queued` and
`importing` (owned by BH2's assignment; BH1 never modifies these rows except
through BH2 helpers), `failed` (assignment failed).

Migration 00004 also rebuilds `import_jobs` so `source` accepts `bookheap`
(rows, indexes and foreign keys preserved). Its down step drops
`bookheap_items` and maps `bookheap` jobs back to `upload`; heap files stay on
disk and a later scan re-indexes them.

Cover blobs referenced by `bookheap_items.cover_sha256` count as referenced in
the orphan sweep. Heap file hashes do not keep `files/` blobs alive (the heap
holds its own file).

## Concurrency

`Service.commitMu` serializes duplicate checks, file naming/renames, row writes
and deletions across uploads, scan writes and deletes. It is always taken
before a writer transaction, never while holding one. Hashing and extraction
run outside the lock. The scan writes one small transaction per file.

## Upload

1. Validate the name (`importer.ValidFilename`) and stream the single `file`
   part to the temp file while hashing; more than `MaxUploadBytes` → 413,
   empty → 400.
2. Duplicate pre-check (library `book_files` first, then any heap item) → 409.
3. Sniff/extract outside the lock. Unsupported/corrupt → 415. Metadata or cover
   failure on a sniffable file is not fatal: the title falls back to the file
   name and the reason goes to `error`. Covers are normalized and published
   with `PublishCover`.
4. Under `commitMu` + a writer transaction: re-check duplicates, choose
   `Name.ext`, `Name (2).ext`, ... (sanitized stem, extension from the sniffed
   format, Windows-reserved names suffixed with `_`), skipping names that exist
   on disk or as rows. The temp file is hard-linked to the name (never
   replaces; falls back to rename where links are unsupported), then the row is
   inserted. On failure the final file is removed.

## Scan

One scan at a time, in a goroutine tied to the service lifetime (not the
request); `Close` cancels it. Scan results are in memory only (`id` restarts at
1 after a restart). Walk: depth 8, at most 100,000 entries (more → the scan
fails and removes nothing). Entries starting with `.` are ignored and not
counted. Symlinks, non-regular files, unsupported extensions and directories
past the depth limit count as `skipped`. Per file:

- indexed with the same size and mtime → `unchanged`;
- modified within the last 10 seconds → `in_progress` (not indexed yet);
- indexed and `queued`/`importing` → `unchanged` (never touched);
- otherwise open through `os.Root` (same-file check), hash, sniff, extract;
  re-`Lstat` under the lock (changed meanwhile → `in_progress`); then insert
  (`added`) or update (`updated`) with status `ready`, `duplicate` (+ reference
  to the library book or the lower-ID heap item) or `invalid` (+ reason).
  `invalid` and `duplicates` are additionally counted within `added`/`updated`.
- Finally, rows that were not seen, are not `queued`/`importing`, and whose
  path no longer exists are deleted (`removed`).

Uploads during a scan are safe: the row insert uses `ON CONFLICT(rel_path) DO
NOTHING`, and removal re-checks the file under `commitMu`.

## Delete

`1..500` unique positive IDs, processed one at a time under `commitMu`.
`queued`/`importing` → `busy`; missing row → `not_found`. If the file exists
but its size/mtime differ from the row (or it is no longer a regular file), the
item is left alone with `changed`; unexpected failures report `failed` and are
logged. Otherwise the file is removed (a missing file is fine) and then the
row. Covers become eligible for the orphan sweep once unreferenced.

## Security

- All endpoints: `SessionMiddleware` + `RequireRole("admin")`; mutations
  (`POST`) use cookie protection. The service re-checks the admin viewer.
- All file access goes through `os.Root` on the heap directory; parent
  components and leaves are `Lstat`-checked (no symlinks), opened files are
  compared with `os.SameFile`. Stored paths are validated as local and free of
  dot components.
- Responses contain only heap-relative paths; error text is passed through
  `safeError` (heap path replaced by `[bookheap]`, control characters
  stripped, 512 bytes max). Logs never include file contents.

## Helpers for BH2

- `Service.deleteItem(ctx, id, allowBusy)` removes a file+row with the same
  same-file checks; `allowBusy=true` is for removing an item after a
  successful import.
- `lstatRegular`/`openRegular` open an item's file safely through the root.
- `duplicateOf(ctx, queries, sha, beforeID)` returns `*DuplicateError`.
- Keep the importer independent of this package (pass an interface into the
  importer hook) to avoid an import cycle: `bookheap` imports `importer`.

## Assignment (BH2)

`POST /api/v1/admin/bookheap/assign` (admin, cookie-protected) turns heap
items into normal import jobs with source `bookheap`
(`internal/bookheap/assign*.go`, `internal/httpapi/bookheap_assign.go`).

- **Whole-request checks first.** `ids` 1..500 unique positive, `shelf_ids`
  0..20 unique positive (omitted = `[]`), the library must exist (404), and
  every shelf must pass `catalog.CheckAssignableShelf`: visible (404), manual
  (automatic → 400), writable by the viewer, and not another user's private
  shelf even for admins (400). Favorites is allowed; Unshelved has no ID.
  Shelf failures are problems with a `shelf_id` extension. Nothing is queued
  on failure.
- **Per item** (request order): only `ready`/`failed` items qualify
  (`not_assignable` otherwise, `not_found` if missing). The file is opened
  through the heap `os.Root` and must match the stored size/mtime; it is
  copied with `importer.Stage`, then re-checked (same file, size, mtime and
  the staged SHA-256 equals the indexed one). A mismatch discards the staging
  copy, records "The file changed on disk; run a scan to refresh it." on the
  item and returns `changed`. Under `commitMu`, `importer.QueueHooked`
  creates the job and, in the same transaction, flips the row to `queued`
  (conditional on `ready`/`failed` and the same size/mtime) with
  `target_library_id`, `target_shelf_ids`, `import_job_id` and a cleared
  error. Losing that race returns `not_assignable` and queues nothing, so
  concurrent assignments queue an item once. Unexpected errors return
  `failed` and are logged.
- **Import hook.** The importer has one source-specific `importer.Hook`
  (`SetHook("bookheap", …)` before `Start`; upload and drop jobs never call
  it). The manifest carries `{item_id, rel_path, size, mtime_ns, shelf_ids}`.
  - `Started`: the item becomes `importing` when a worker claims the job.
  - `Imported`: inside the transaction that creates the book (after the file
    row and search index), adds the book to each target shelf through
    `catalog.AddAssignedBookTx` as the assigning user (role re-read; disabled
    or deleted users skip all shelves). Shelves that were deleted or became
    non-writable are skipped and the count is logged. Then the heap row is
    deleted. Any other error rolls back the import and fails the job.
  - `Finished` (after the job is final, before the manifest is removed):
    `imported` removes the heap file under `commitMu` only if size/mtime (and
    `os.SameFile` with the staged file, when this process queued it) still
    match; otherwise the file is kept and a warning logged. A row that a scan
    re-created for the removed path is deleted. `duplicate` sets the item to
    `duplicate` with `duplicate_of_book_id`; `failed` sets `failed` with the
    safe error. Files are kept for both and failed items can be retried.
- **Restart.** `processing` jobs return to `pending` (existing importer
  behavior) and the hook runs again. Manifests of jobs that finished before
  the restart run `Finished` and then cleanup from a background goroutine
  after `Start`, so the hook is at-least-once and idempotent. `Recover` runs
  in `Start` and reconciles every `queued`/`importing` row: job missing →
  `failed` ("The import job was lost; assign the item again."); job `failed` →
  `failed`; `duplicate` → `duplicate`; pending/processing jobs are left alone.
- **Locks.** `commitMu` → importer mutex → writer transaction. The `Imported`
  hook runs inside the importer transaction and never takes `commitMu`.
  Scan and delete keep skipping `queued`/`importing` rows.
