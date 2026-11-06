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
