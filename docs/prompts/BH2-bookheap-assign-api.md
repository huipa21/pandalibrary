# BH2: Bulk assignment of heap items to a library and shelves

- Status: Ready (re-read BH1's hand-off before starting)
- Wave: 2; dependencies merged: BH1
- Can run in parallel with: BH4
- Migration: no (BH1 already added the columns and the `bookheap` import source)
- Branch/worktree: `task/bh2` / `..\pandalibrary-bh2`

## Read first

- [Bookheap plan](../plans/bookheap-plan.md): decisions 2, 3, 8 and 11, and
  the `assign` row of the shared contract (binding: BH4 codes against it).
- BH1 hand-off in [BH1](./BH1-bookheap-storage-api.md) and
  [architecture/bookheap.md](../architecture/bookheap.md).
- `internal/importer/{service,pipeline,watcher}.go`: `enqueue`, manifests,
  recovery after restart, `importBook`, `createBook`, `cleanup`/`cleanupDrop`
  (same-file checks before removing a source), `finish`, workers.
- Shelf write rules: `internal/catalog/shelves*.go`, `shelf_rules.go`
  (manual vs automatic, system Favorites, shared/private write permission),
  and `httpapi/shelves.go` `putShelfBook`.

## Goal

Admins can pick many heap items and assign them in one request to a library,
optionally with shelves. Each item becomes a normal import job through the
existing importer pipeline. When an item imports successfully, the book exists
in the library and on the chosen shelves, the heap row is gone, and the heap
file has been removed. Duplicates and failures stay in the heap with a reason,
and failed items can be retried.

## Scope

**Owns:**
- `internal/bookheap/assign*.go` (+ tests)
- `internal/httpapi/bookheap_assign.go` (+ tests), mounted from BH1's mount
  or a new localized mount line in `app.go`
- Additional queries appended in a new file `internal/db/queries/bookheap_assign.sql`
  (regenerate sqlc; do not hand-edit generated code)

**Shared (narrow, reviewed changes):**
- `internal/importer/**`: add source `bookheap` and a narrow, source-specific
  completion hook (for example `Options.Hooks` or a `Completion` interface
  called inside the import transaction and after cleanup). The upload and
  drop-folder paths must behave exactly as before.
- `internal/catalog`: export, if needed, a transaction-scoped helper that
  checks shelf writability and inserts manual shelf membership. Reuse the
  existing rules; do not duplicate or weaken them.
- `internal/app/app.go`: wire the hook (localized lines).
- `docs/architecture/bookheap.md`: append an "Assignment" section.

**Must not touch:** BH1 upload/scan/delete behavior (except shared helpers
agreed in BH1's hand-off), `web/**`, migrations.

## Requirements

1. `POST /api/v1/admin/bookheap/assign` (admin, cookie-protected), body
   `{ids, library_id, shelf_ids}`. `ids`: 1..500 unique positive integers.
   `shelf_ids`: 0..20 unique positive integers (omitted means `[]`). Unknown
   JSON fields and wrong types return 400.
2. Whole-request validation before anything is queued: the library exists
   (`404` otherwise). Every shelf exists, is visible to the viewer, is manual
   (not automatic, not virtual Unshelved) and is writable by the viewer.
   Favorites is allowed. Violations return `400` or `404` problem responses
   naming the offending shelf ID. Nothing is queued if validation fails.
3. Per item (in one writer transaction per item, or a small batch):
   only `ready` and `failed` items are assignable. Others return
   `not_assignable`, and missing ones return `not_found`. For each assignable
   item:
   - re-check the file through the heap `os.Root` (regular file, same
     size/mtime as recorded). If it changed, mark the item for rescan and return
     `changed`;
   - stage it through `importer.Stage` (copying; the heap file stays until
     success) and enqueue an import job with source `bookheap`, the target
     library and `user_id` = viewer. Its manifest carries the heap item ID,
     relative path, size, mtime and shelf IDs, so recovery after a restart
     works;
   - set the item to `queued` with `target_library_id`, `target_shelf_ids` and
     `import_job_id`, and clear `error`;
   - return `{id, ok: true, error: null, import_job_id}`.
   Respond `202 {results}` in request order.
4. Import completion for source `bookheap`:
   - entering processing sets the item to `importing`;
   - `imported`: in the same transaction that creates the book, add the book to
     each target shelf the assigning user can still write. Silently skip shelves
     that were deleted or became non-writable, and log the count. Then delete
     the heap row. After commit, remove the heap file only if it is still the
     same file (size/mtime/`os.SameFile`); if it changed, keep it and log.
     Never remove the file before the book commit;
   - `duplicate`: item becomes `duplicate` with `duplicate_of_book_id`. File is
     kept;
   - `failed`: item becomes `failed` with the safe error. File is kept and it
     can be retried;
   - crash/restart: existing manifest recovery must finish or fail the job
     and leave the heap row consistent. A `queued`/`importing` heap row whose
     job is gone or finished is reconciled on startup.
5. Import history (`GET /api/v1/imports`) shows these jobs with source
   `bookheap`. Search FTS and covers behave as for uploads.
6. Concurrency: assigning the same item twice concurrently queues it once. A
   heap delete or scan racing with an assignment respects `queued`/`importing`.
   Shutdown leaves recoverable state.

## Out of scope

- Moving books that are already in a library, or adding existing library books
  to shelves in bulk (only heap items).
- UI (BH4).

## Acceptance criteria

- [ ] Assigning N ready items with two shelves creates N books in the library,
      each on both shelves. Heap rows and files are gone, and import history
      shows `bookheap` jobs.
- [ ] Duplicate and corrupt items end as `duplicate`/`failed` with files kept.
      Retrying a failed item works.
- [ ] Invalid library, automatic shelf, Unshelved, another user's private
      shelf, or a shared shelf without permission rejects the whole request
      with nothing queued.
- [ ] Restart while queued/importing recovers. Changed or missing heap files
      are handled without data loss.
- [ ] Existing upload/drop-folder importer tests still pass unchanged.
- [ ] `task sqlc:check lint test build` passes.

## Validation commands

```powershell
task sqlc
task sqlc:check
go test ./internal/bookheap/... ./internal/importer/... ./internal/httpapi/... ./internal/catalog/...
task lint test build
```

## Hand-off

Record the exact request/response examples, the per-item error codes, the
hook design, and the restart behavior here. Update the BH4 prompt if the
contract changed. Update your progress row and append a dated log.
