# BV1: Catalog API – file name/added date and shelves containing a book

- Status: Done
- Wave: 1. Dependencies merged: baseline `72c469c`
- Can run in parallel with: BV2, BV3, BV4
- Branch/worktree: `task/bv1` / `..\pandalibrary-bv1`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md): decisions 4 and 13, the shared API
  contract rows owned by BV1, the verification policy.
- `internal/catalog/types.go` (`BookFile`, `Book`), `internal/catalog/shelves.go`
  (shelf visibility, `Shelf` DTO), `internal/db/queries/catalog.sql`,
  `internal/db/queries/shelves.sql`, `internal/httpapi/catalog.go`,
  `internal/httpapi/shelves.go`, and their `_test.go` files.
- [architecture/system.md](../architecture/system.md) (API conventions),
  [docs/architecture/ux2-shelves.md](../architecture/ux2-shelves.md) (system
  shelves, Favorites, Unshelved).

## Goal

The quick view and the Files tab can show each file's original name and added
date, and the quick view can list the viewer's collections (manual shelves)
that contain a book. Both are additive, backward-compatible API changes with
no migration.

## Scope

**Owns:** `internal/catalog/**` changes for these features, new queries
appended to `internal/db/queries/catalog.sql` / `shelves.sql`, regenerated sqlc
output (`task sqlc`), the handlers and routes in `internal/httpapi/catalog.go`
and `shelves.go`, and tests.

**Must not touch:** `internal/reading/**` (BV2), any `web/**` file (BV3 adds
the optional TS fields), migrations.

## Subtasks

### BV1.1 – Extend the `BookFile` DTO

> In `internal/catalog`, add `OriginalFilename string \`json:"original_filename"\``
> and `CreatedAt time.Time \`json:"created_at"\`` to `BookFile`. Fill them from
> `book_files.original_filename` and `book_files.created_at` (Unix ms → UTC)
> everywhere `BookFile` is built: list, detail, shelf book pages, dashboard
> feeds and any other `Book` producer (grep for `BookFile{`). Always return a
> base name. Apply `filepath.Base` after normalizing `\` to `/`, and never
> expose a directory path. If the stored name is empty, use
> `"<book title>.<format>"`. Update the query columns and regenerate sqlc. Add or
> extend the catalog service and HTTP tests: the fields are present on list and
> detail, the name is a base name even when stored with directories, and the
> timestamp is RFC3339 UTC. Keep the existing JSON fields byte-compatible.

### BV1.2 – `GET /api/v1/books/{id}/shelves`

> Add an authenticated, read-only endpoint `GET /api/v1/books/{id}/shelves`
> returning `{"shelves": Shelf[]}`, using the exact `Shelf` DTO and visibility
> rules of `GET /api/v1/shelves`. Include only **manual** shelves (custom
> manual shelves and the Favorites system shelf) that the viewer can see and
> that contain the book (`shelf_books`). Exclude automatic shelves and
> Unshelved. Sort by `name` (case-insensitive), then `id`. Return `404` (problem
> JSON) when the book is missing or invisible to the viewer (library grant or
> hide list, as `GET /books/{id}`), and `400` for an invalid ID. Reject unknown
> query parameters with `400`, like the other catalog handlers. Cap the result
> at 200 shelves. `visible_book_count` must stay consistent with
> `/api/v1/shelves`. Tests: own private shelf, a shared shelf visible to the
> viewer, another user's private shelf (excluded), Favorites, an automatic shelf
> (excluded), a hidden book (404), an invisible library (404) and
> unauthenticated access (401).

### BV1.3 – Document

> Document both changes in [architecture/system.md](../architecture/system.md)
> (API list) and in the plan contract, if anything differs from it.

## Out of scope

Per-user reading data (BV2), any UI (BV3-BV9), automatic-shelf evaluation
for a single book.

## Acceptance criteria

- [ ] `files[]` items include `original_filename` (base name) and `created_at` on
      every endpoint that returns `Book`.
- [ ] `/api/v1/books/{id}/shelves` matches the contract and the visibility rules
      above, with tests for each listed case.
- [ ] No migration. sqlc output is regenerated and in sync.

## Validation commands (targeted only; full gate runs in BV10)

```powershell
task sqlc:check
go test ./internal/catalog/... ./internal/httpapi/...
```

## Hand-off

Set this prompt to Done, update the BV1 row and add a log entry in
[progress/README.md](../progress/README.md). Note any contract deviation in
the plan.
