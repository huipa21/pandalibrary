# BH1: Bookheap folder, index table, upload/list/delete/cover/scan API

- Status: Done
- Wave: 1; dependencies merged: baseline `2566569`
- Can run in parallel with: BH3
- Migration: yes, sole writer for the bookheap follow-up (`00004`)
- Branch/worktree: `task/bh1` / `..\pandalibrary-bh1`

## Read first

- [Bookheap plan](../plans/bookheap-plan.md): product decisions 1-11, the
  shared API contract and ownership rules. The contract there is binding,
  because BH3/BH4 build against it in parallel.
- [architecture/system.md](../architecture/system.md),
  [architecture/database.md](../architecture/database.md),
  [architecture/migrations.md](../architecture/migrations.md), ADR-0002/0003.
- Existing code: `internal/importer/{service,watcher,pipeline}.go` (staging,
  sniffing, safe `os.Root` file handling, drop-folder rules),
  `internal/extract` (registry, `Sniff`), `internal/covers` (`Normalize`),
  `internal/blobstore` (`PublishCover`, `OpenCover`, `CoverPath`),
  `internal/httpapi/imports.go` (multipart parsing, error mapping),
  `internal/httpapi/catalog.go` (paging/cursor/problem helpers),
  `internal/jobs/maintenance.go` (orphan sweep, drop overlap guard),
  `internal/config/config.go`, `internal/app/app.go`.

## Goal

When this task is done, the server has a configured, persistent heap folder.
Admins can upload files into it over HTTP, which stores the file and a
`bookheap_items` row with extracted metadata and a cover. They can list,
filter, page, inspect and bulk-delete heap items, and start a background
**scan** that reconciles files copied directly into the folder with the
database. Assignment to libraries is BH2; all UI is BH3/BH4.

## Scope

**Owns (create/modify freely):**
- `internal/bookheap/**` (new package: service, scanner, store, tests)
- `internal/db/queries/bookheap.sql` (new) and regenerated `internal/db/sqlc/**`
- `internal/db/migrations/00004_bookheap.sql`, `migrations.sum`
- `internal/httpapi/bookheap.go`, `internal/httpapi/bookheap_test.go`
- `docs/architecture/bookheap.md` (new)

**Shared files (localized edits only):**
- `internal/config/config.go` (+ test): `BookheapDir` flag/env
- `internal/app/app.go`: create the directory, construct the service, add one
  `httpapi.BookheapMount(...)` line, close the service on shutdown
- `internal/jobs/maintenance.go` (+ test): treat heap cover hashes as
  referenced, and skip/guard the sweep if the heap directory overlaps storage
- `internal/importer/service.go`: only if you must export a narrow helper
  (for example, filename validation or the extract registry constructor). Do
  not change importer behavior.
- `README.md` configuration table: one row for the new setting

**Must not touch:** `web/**` (BH3/BH4), the assignment logic or the assign
endpoint (BH2), import job processing, catalog visibility code.

## Requirements

1. **Config.** Add `--bookheap-dir` / `PANDA_BOOKHEAP_DIR`, defaulting to
   `<data-dir>/bookheap`, resolved to an absolute path. Startup creates it with
   mode `0750` and fails clearly if it equals, contains or is inside the drop
   directory or `<data-dir>/{files,covers,tmp,backups}`, or the database
   directory. Unit-test the validation.
2. **Migration `00004_bookheap.sql`** (up and down, checksum updated):
   - `bookheap_items`: `id INTEGER PRIMARY KEY`, `rel_path TEXT NOT NULL UNIQUE`
     (slash-separated, relative to the heap root), `file_name`, `size_bytes`
     (`>= 0`), `mtime_ns INTEGER NOT NULL`, `sha256` (64 hex, nullable only for
     unreadable files), `format` (nullable, the same CHECK list as
     `book_files.format`), `title`, `authors` (JSON array text,
     `json_valid`), `language`, `series`, `series_index`, `cover_sha256`
     (nullable, length 64), `source` CHECK `('upload','scan')`, `status` CHECK
     `('ready','duplicate','invalid','queued','importing','failed')`, `error`,
     `duplicate_of_book_id` (FK books `ON DELETE SET NULL`),
     `duplicate_of_item_id` (FK self `ON DELETE SET NULL`),
     `target_library_id` (FK libraries `ON DELETE SET NULL`),
     `target_shelf_ids` (JSON array text, default `'[]'`), `import_job_id` (FK
     import_jobs `ON DELETE SET NULL`), `added_by` (FK users `ON DELETE SET
     NULL`), `created_at`, `updated_at` (Unix ms, like the rest of the schema).
     Add indexes for `(created_at, id)`, `sha256`, and `status`.
   - Rebuild `import_jobs` so its `source` CHECK also allows `'bookheap'`
     (SQLite cannot alter CHECK constraints). Preserve all rows, indexes and
     FKs. The down migration maps `bookheap` rows back safely or deletes them,
     and documents which. Test up/down/up on a database containing import
     jobs.
   - The assignment columns are for BH2. BH1 only stores defaults in them.
3. **Service (`internal/bookheap`).** Construct with writer/reader DBs, blob
   store, heap dir, max bytes and logger. Reuse the importer's extract registry
   setup (export a constructor rather than duplicating format registration). All
   file access goes through `os.Root` on the heap directory. Reject symlinks,
   non-regular files and any path that is not local. Never follow user-supplied
   paths. Extraction is bounded like the importer and honors context
   cancellation.
4. **Upload** `POST /api/v1/admin/bookheap/files` (admin, cookie-protected),
   exactly one `file` part. Validate the filename with the importer's
   `ValidFilename` rules. Stream into a `.upload-<random>.part` temp file in the
   heap root while hashing (SHA-256), and enforce `MaxUploadBytes` (`413`). Then:
   - if the SHA-256 matches a `book_files` row or a heap item, delete the temp
     file and return `409` problem JSON with extension member
     `duplicate_of_book_id` or `duplicate_of_item_id` (add a small
     problem-with-extensions helper if none exists);
   - sniff the format. If it is unsupported or corrupt, delete the temp file and
     return `415`;
   - extract metadata and cover. Publish the normalized cover with
     `PublishCover`. A metadata extraction failure on a sniffable file is not
     fatal: store the item with the file-name title and put the reason in
     `error`;
   - atomically rename to a unique sanitized name in the heap root (`Name.ext`,
     `Name (2).ext`, ...; never overwrite), insert the row
     (`source='upload'`, `status='ready'`, `added_by` = viewer), and return
     `201 {item}`;
   - on any failure after the temp file exists, remove it. Concurrent uploads of
     the same content must produce exactly one item and one 409.
5. **List/get/cover/delete** exactly per the plan's contract, including the
   `cover_url` field, `q` and `status` filters, `total` for the current filter,
   opaque filter-bound cursors with default 50 / maximum 100, and `[]` (never
   `null`) for arrays. Bulk delete takes `1..500` unique positive IDs and
   returns per-item results. `queued`/`importing` items get `busy`. Deleting
   removes the file (same-file check against the stored size/mtime; if the file
   is already gone, just delete the row) and then the row. Covers become
   eligible for the orphan sweep once unreferenced.
6. **Scan** `POST /api/v1/admin/bookheap/scan` / `GET .../scan`. Only one scan
   runs at a time, in a background goroutine tied to the service lifetime (not
   the request context); stop it cleanly on shutdown. Walk the heap recursively
   (depth 8, 100,000 entries). Skip dot-prefixed entries, symlinks, non-regular
   files, and files modified within the last 10 seconds (`in_progress`). Per
   file:
   - path not indexed, supported format: hash, sniff, extract, insert
     `source='scan'` with status `ready`, or `duplicate` (+ reference) when the
     hash matches a library file or an earlier heap item;
   - sniffable extension but corrupt/unsupported content: insert as `invalid`
     with a reason;
   - extension not in the supported list: count as `skipped`, do not index;
   - path indexed, size/mtime unchanged: `unchanged`;
   - changed: re-hash/re-extract and update, unless `queued`/`importing`;
   - finally, delete rows (not `queued`/`importing`) whose file no longer
     exists: `removed`.
   Write in small transactions so the writer is not blocked for the whole scan.
   Record counts and the failure reason in the in-memory scan DTO. Also
   recognize files that BH1 uploads while a scan is running (rel_path
   uniqueness makes this idempotent).
7. **Maintenance.** The orphan sweep must treat `bookheap_items.cover_sha256` as
   referenced, and must refuse or skip the sweep if the heap directory overlaps
   a storage root, mirroring the existing drop-directory guard. Add tests.
8. **Security.** All endpoints use `SessionMiddleware` + `RequireRole("admin")`,
   and mutations use cookie protection. Responses never contain absolute server
   paths. Log without file contents. Error messages are safe and generic, like
   the importer's `safeError`.

## Out of scope

- Assigning items to libraries/shelves and the `bookheap` import hook (BH2).
- All web UI (BH3, BH4). Changing `/api/v1/uploads` or the drop folder.

## Acceptance criteria

- [x] Upload stores exactly one file in the heap folder and one row with
      metadata/cover. Duplicate/oversize/unsupported/invalid-name uploads
      leave no file behind and return the documented status.
- [x] Copying epub/pdf/cbz fixtures (from `internal/extract/testdata` or
      `internal/importer` tests), a nested folder, a dot file, a symlink, an
      unknown extension, a corrupt `.epub` and a just-modified file into the
      heap, then scanning, yields the correct rows and counts. A second scan is
      all `unchanged`. Deleting a file on disk and rescanning removes its row.
- [x] Concurrency: double scan start returns the running scan; parallel
      identical uploads produce one item; shutdown during a scan is clean.
- [x] Non-admin and unauthenticated requests get 403/401; mutations without
      cookie protection are rejected.
- [x] Orphan sweep keeps heap covers and has an overlap guard. Migration
      up/down/up preserves import jobs.
- [x] `task sqlc:check lint test build` passes.

Verification: the real-server suite scans EPUB, PDF and CBZ fixtures and checks
the second scan. The Linux scan tests exercised a real symlink. `task build`
wrote its executable outside the checkout to preserve the existing ignored
binary.

## Validation commands

```powershell
task sqlc
task sqlc:check
go test ./internal/bookheap/... ./internal/httpapi/... ./internal/jobs/... ./internal/config/... ./internal/db/...
task lint test build
```

## Hand-off

- Record in this prompt: the exact DTO/example responses (especially the 409
  extension members and the scan DTO), the service methods BH2 needs (for
  example, loading items for update, status transitions, opening an item's file
  through the root), and any deviation from the plan contract. If the contract
  changed, update the BH2/BH3/BH4 prompts before they launch.
- Create `docs/architecture/bookheap.md` (data model, folder rules, scan
  algorithm, security). Update your progress row and append a dated log.

## Hand-off (BH1 done)

Implemented as specified; details in `docs/architecture/bookheap.md`.

- Endpoints (all admin-only, `POST` cookie-protected) under `/api/v1/admin/bookheap`:
  `POST /files` (one multipart `file` part) → `201 {"item": Item}`;
  `GET /items?status=&q=&limit=&cursor=` → `{"items":[...],"next_cursor":string|null,"total":n}`;
  `GET /items/{id}` → `{"item": Item}`; `GET /items/{id}/cover?thumbnail=1` (JPEG,
  ETag, `thumbnail=0` for full size); `POST /items/delete {"ids":[...]}` →
  `{"results":[{"id":1,"ok":true,"error":null},{"id":77,"ok":false,"error":"not_found"}]}`;
  `POST /scan` (no body) → `202 {"scan": Scan}` when started, `200` with the
  running scan otherwise; `GET /scan` → `{"scan": Scan|null}`.
- Upload errors: 409 problem with `duplicate_of_book_id` ("This file is already in
  the library.") or `duplicate_of_item_id` ("This file is already in the
  bookheap."); 413 too large; 415 unsupported/corrupt; 400 empty/bad name/not
  exactly one `file` part; 503 while shutting down.
- Scan DTO: `id, status (running|completed|failed), started_at, finished_at,
  added, updated, removed, unchanged, invalid, duplicates, skipped, in_progress,
  error`. Scans are in memory; `id` restarts at 1 per process.
- Deviations/clarifications:
  - Delete error codes are `not_found`, `busy`, `changed` (file on disk no
    longer matches the row; nothing removed) and `failed` (unexpected error,
    logged). BH4 should show `changed`/`failed` as generic failures.
  - `invalid` and `duplicates` scan counters are also included in `added`/`updated`.
  - The duplicate check runs before content sniffing, so re-uploading a file
    identical to an `invalid` heap item returns 409, not 415.
  - Migration 00004 down maps `bookheap` import jobs back to `upload`.
- For BH2 (`internal/bookheap`): `Service.deleteItem(ctx, id, allowBusy)`
  (same-file checked removal of file + row), `lstatRegular`/`openRegular`
  (root-confined access to an item file), `duplicateOf(ctx, q, sha, beforeID)`,
  `Service.Dir()`, and `commitMu` (take before any writer transaction). The
  `bookheap` package imports `importer`, so the importer completion hook must
  use an interface defined in `importer`.
