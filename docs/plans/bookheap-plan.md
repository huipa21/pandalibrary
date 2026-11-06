# Bookheap: header upload, staging folder, scan, and bulk assignment

Status: Ready for implementation. Requested 2026-11-06.
Baseline: `2566569` (`master`). These are local issue specifications; nothing
is published to GitHub. Implementation is not part of this planning change.

## Request (as given)

1. Uploading currently lives in a deeply nested admin page
   (`/admin/imports`, which also requires choosing a library first). Add an
   **Upload** button to the top header.
2. Upload opens a popup with a drag-and-drop area, a **Select files** button and
   a **Clear** button. Dropped/selected files form a list; selecting again adds
   only files that are not already listed. Each row has an **X** that removes
   only that file; Clear removes all. An **Upload** button starts uploading.
3. The backend has a `bookheap` folder used as a staging area. Uploaded files
   are physically stored there, and their info is stored in the database.
4. Files copied onto the server straight into that folder have no database
   rows, so they must be discovered. The Bookheap page gets a **Scan** button.
5. The frontend gets a **Bookheap** menu item directly below **All Books**,
   listing everything in the heap. From there books are assigned to a library
   or shelves, with bulk actions.

## Assessment of the current code

- `POST /api/v1/uploads` (admin only, one multipart file plus a required
  `library_id`) stages the upload and queues an `import_jobs` row. Two importer
  workers extract metadata and covers, publish the file into the
  content-addressed blobstore (`files/<sha[0:2]>/<sha>.<format>`), create the
  `books`/`book_files` rows, index FTS and dedupe by SHA-256.
- `books.library_id` is `NOT NULL`. Library visibility, shelves, search, OPDS,
  stats and the dashboard all assume every book belongs to a library.
- The existing drop folder (`PANDA_DROP_DIR`) imports automatically into the
  default library or slug subfolders and then removes or archives the source.
  It has no review step. It stays unchanged.
- The J1 orphan sweep deletes unreferenced `covers/` blobs older than 24 h, and
  refuses to run if a storage root overlaps the drop directory.
- Book `PATCH` can already change `library_id`. Shelf membership is single-item
  only (`PUT /api/v1/shelves/{id}/books/{bookID}`). There is no bulk API.
- The header (`web/src/lib/shell/AppShell.svelte`) holds the menu toggle,
  brand, search and account controls. HOME navigation (`web/src/lib/nav.ts`)
  is Dashboard, All Books, Bookmarks, Notes. Nav items already support a
  `role` filter.

## Product decisions used by these prompts

These are explicit defaults. Change them here and in the affected prompts
before launching a wave.

1. **The heap is a staging index, not "books without a library".** A new
   `bookheap_items` table indexes files that physically live in the heap folder.
   Heap items are not `books`. They never appear in All Books, search, OPDS,
   stats, shelves or the dashboard, and need no change to visibility rules or
   to `books.library_id NOT NULL`.
2. **Assignment imports the file.** Assigning items to a library runs them
   through the existing importer pipeline (same extraction, covers, FTS and
   dedupe code). On success the book exists in that library, the heap row is
   deleted and the file is removed from the heap folder, because it now lives
   in library storage. A failure or a duplicate leaves the file and row in the
   heap with a visible reason.
3. **Shelves require a library.** Every book must belong to a library, so
   **Assign** always takes a target library and optionally one or more
   writable manual shelves (custom manual shelves or Favorites; not automatic,
   Unshelved, or read-only shelves). Shelf membership is added in the same
   transaction that creates the book.
4. **Admin only.** Uploading is admin-only today, and the heap exposes server
   files. The header Upload button, the Bookheap nav item, the `/bookheap`
   route and all heap APIs are admin-only (UI hides them; server enforces with
   `RequireRole("admin")`). Non-admin uploading is a separate decision.
5. **Location.** New config: `--bookheap-dir` / `PANDA_BOOKHEAP_DIR`, defaulting
   to `<data-dir>/bookheap`. Startup creates it and rejects a path that equals or
   overlaps the drop directory or the blob storage roots (`files/`, `covers/`,
   `tmp/`, `backups/`).
6. **Folder rules.** Scan is recursive (maximum depth 8, maximum 100,000
   entries per scan). It ignores dot-prefixed files and folders (including the
   upload temp files), symlinks, non-regular files, and files modified in the
   last 10 seconds (reported as "still being written"). Supported formats are
   those the extract registry sniffs: epub, pdf, mobi, azw3, fb2, fbz, cbz.
   Unsupported or corrupt files are indexed as `invalid` with a reason, so the
   admin can see and delete them. Unknown extensions are counted as skipped and
   not indexed.
7. **Uploads.** One file per request (multipart part `file`), at most
   `MaxUploadBytes` per file. The server streams to a dot-prefixed temp file in
   the heap root, sniffs the format, then atomically renames to a sanitized
   unique name (`Name.epub`, `Name (2).epub`, ...) and inserts the row. The
   client uploads with concurrency 2 so it can show per-file progress and
   errors.
8. **Duplicates.** An upload whose SHA-256 matches an existing library file or
   an existing heap item is rejected with `409` and not stored. The client shows
   which. Scan cannot refuse a file the admin copied in, so it indexes such
   files with `status = "duplicate"` and a reference. The file is never deleted
   automatically.
9. **Scan.** Scans run in the background and only one runs at a time. Scan
   adds new files, re-extracts files whose size or mtime changed, and deletes
   rows whose file disappeared (except `queued`/`importing` rows). It returns
   counts. The latest scan status is kept in memory only.
10. **Deleting from the heap** (bulk) removes the file and the row after
    confirmation. Queued or importing items cannot be deleted.
11. The existing `/admin/imports` upload form, the drop folder, `POST
    /api/v1/uploads` and the import history are unchanged. Heap assignments show
    up in import history with the new source `bookheap`.

## Shared API contract (all admin-only, cookie-protected mutations)

`HeapItem` DTO (timestamps RFC3339 UTC):

```json
{
  "id": 12,
  "file_name": "Dune.epub",
  "rel_path": "uploads/Dune.epub",
  "format": "epub",
  "size_bytes": 1048576,
  "sha256": "<64 hex>",
  "title": "Dune",
  "authors": ["Frank Herbert"],
  "language": "en",
  "series": null,
  "series_index": null,
  "has_cover": true,
  "cover_url": "/api/v1/admin/bookheap/items/12/cover",
  "source": "upload",
  "status": "ready",
  "error": null,
  "duplicate_of_book_id": null,
  "duplicate_of_item_id": null,
  "target_library_id": null,
  "target_shelf_ids": [],
  "import_job_id": null,
  "added_by": 1,
  "created_at": "2026-11-06T05:00:00Z",
  "updated_at": "2026-11-06T05:00:00Z"
}
```

`format` is `null` for `invalid` items. `title` falls back to the file name
without its extension when metadata has none. `status` is one of `ready`,
`duplicate`, `invalid`, `queued`, `importing`, `failed`.

| Method | Path | Owner | Behavior |
|---|---|---|---|
| POST | `/api/v1/admin/bookheap/files` | BH1 | multipart, exactly one part `file` with a valid filename. `201 {item}`. `400` invalid multipart/name, `409` duplicate (problem + `duplicate_of_book_id` or `duplicate_of_item_id`), `413` too large, `415` unsupported/corrupt format, `503` stopping |
| GET | `/api/v1/admin/bookheap/items?status=&q=&limit=&cursor=` | BH1 | `{items, next_cursor, total}`; newest `created_at`, then `id` descending; `q` matches title/author/file name (case-insensitive substring); limits default 50, max 100; opaque filter-bound cursor |
| GET | `/api/v1/admin/bookheap/items/{id}` | BH1 | `{item}` or 404 |
| GET | `/api/v1/admin/bookheap/items/{id}/cover?thumbnail=1` | BH1 | JPEG from the cover blob; 404 when none |
| POST | `/api/v1/admin/bookheap/items/delete` | BH1 | body `{ids: [1..500 unique positive]}`; `200 {results: [{id, ok, error}]}`, per-item `not_found` / `busy` |
| POST | `/api/v1/admin/bookheap/scan` | BH1 | `202 {scan}` when started; `200 {scan}` with the running scan if one is already running |
| GET | `/api/v1/admin/bookheap/scan` | BH1 | `{scan}` or `{scan: null}` |
| POST | `/api/v1/admin/bookheap/assign` | BH2 | body `{ids: [1..500], library_id, shelf_ids: [0..20]}`; `202 {results: [{id, ok, error, import_job_id}]}`. Whole-request `400/404` for an invalid/missing library or a non-writable/automatic/system shelf; per-item `not_found` / `not_assignable` (only `ready` and `failed` items can be assigned) |

`scan` DTO: `{id, status: "running"|"completed"|"failed", started_at,
finished_at, added, updated, removed, unchanged, invalid, duplicates, skipped,
in_progress, error}`.

The frontend listens for and dispatches the `window` event
`pandalibrary-bookheap-changed` (no payload) after uploads, scans, deletions and
assignments.

## Issues and parallel execution

Run one session per issue in a separate branch/worktree from the same updated
`master`. Merge a wave and keep it green before starting the next.

| Wave | Issue | Goal | Dependencies | Migration | Prompt |
|---|---|---|---|---|---|
| 1 | BH1 | Heap folder, index table, upload/list/delete/cover/scan API | baseline | Yes (sole writer) | [BH1](../prompts/BH1-bookheap-storage-api.md) |
| 1 | BH3 | Header Upload button and upload dialog (contract mocks) | baseline | No | [BH3](../prompts/BH3-upload-dialog.md) |
| 2 | BH2 | Bulk assign to library + shelves via the importer | BH1 | No | [BH2](../prompts/BH2-bookheap-assign-api.md) |
| 2 | BH4 | Bookheap page, nav item, Scan, selection, bulk Assign/Delete | BH1, BH3 | No | [BH4](../prompts/BH4-bookheap-page.md) |
| 3 | BH5 | Real-server integration, E2E, docs and release checks | BH1-BH4 | No | [BH5](../prompts/BH5-bookheap-integration.md) |

```text
Wave 1 (parallel):  BH1 backend core  ||  BH3 upload dialog (UI, mocked API)
                         |                    |
Wave 2 (parallel):  BH2 assign API    ||  BH4 Bookheap page (uses BH1 live, BH2 by contract)
                         \                   /
Wave 3 (alone):              BH5 integration gate
```

- BH1 is the only migration writer. It adds the full `bookheap_items` schema,
  including assignment columns, and the `bookheap` import source, so BH2 needs
  no migration.
- BH3 can start immediately because it only needs the upload endpoint
  contract above. It tests against mocks; BH5 verifies it against the real
  server.
- BH4 starts after BH1 (real list/scan/delete) and BH3 (reuses the dialog from
  its toolbar). It codes assignment against the BH2 contract with mocks, so BH2
  and BH4 run in parallel.
- BH5 runs alone after everything is merged.

Example worktree setup for wave 1:

```powershell
git worktree add ..\pandalibrary-bh1 -b task/bh1 master
git worktree add ..\pandalibrary-bh3 -b task/bh3 master
```

In each session: `Implement docs/prompts/BH1-bookheap-storage-api.md`
(substitute its own prompt).

## Ownership and merge protocol

Each prompt's ownership section is authoritative.

- BH1 owns `internal/bookheap/**` (new), heap SQL query file, migration
  00004 + checksum + regenerated sqlc models, heap HTTP file, config flag, and
  the narrow maintenance change (cover references, overlap guard).
- BH2 owns the heap assignment code in `internal/bookheap/assign*.go`, the
  importer source/hook extension, and the assign handler. It must not
  change BH1's upload/scan behavior except through reviewed shared helpers.
- BH3 owns `web/src/lib/bookheap/UploadDialog.svelte`, its upload queue
  module, `web/src/lib/bookheap/api.ts` (upload function and shared types), and
  only the header slot it adds in `AppShell.svelte`.
- BH4 owns `web/src/routes/bookheap/**`, the remaining `web/src/lib/bookheap/**`
  modules it creates (appending list/scan/delete/assign functions to `api.ts`),
  and one HOME nav entry in `nav.ts`.
- Add HTTP mounts in `internal/app/app.go` as separate localized lines.
  Messages use only `bh1.*`…`bh5.*` keys in both `web/messages/en.json` and
  `zh.json`; merge by key union. Never edit generated Paraglide output.
- Each session edits only its own progress row, its prompt status/hand-off, and
  appends one dated log entry. Architecture notes go in
  `docs/architecture/bookheap.md` (created by BH1, extended by BH2). BH5
  reconciles README/system indexes.
- No dependency changes without a demonstrated need; no ACL relaxations.

## Shared UX contract

Same as the sidebar/dashboard plan: typed API client and `ApiError`, problem
responses, localized English/Chinese copy, accessible names for icon buttons,
focus trap/restore in dialogs, Escape to close, explicit
loading/empty/error/retry states, stale-response suppression, and no
client-only authorization.
