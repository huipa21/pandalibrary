# SH1: Shelves

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § SH1
- Depends on (merged): C1
- Can run in parallel with: W2, I1, S1
- Branch / worktree: `task/sh1` in `..\pandalibrary-sh1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 5–6, 15
- [architecture/database.md](../architecture/database.md) §§1–5, 9–10
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md) and
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- C1's `catalog.Service`, visibility predicate, book DTO hydration and pagination helpers;
  `internal/db/migrations/00001_init.sql`, generated sqlc package, and current
  `httpapi.Mount`/application wiring

## Goal

Implement private and administrator-shared shelves using the existing schema. Owners and
admins can manage shelf contents and manual order; readers can see only shelves and books
they are authorized to see, with inaccessible or hidden books consistently filtered.

## Scope

**Owns (create/modify freely):**
- Shelf operations in `internal/catalog/shelves*.go`
- `internal/db/queries/shelves.sql` and generated sqlc output from `task sqlc`
- Shelf HTTP handlers and tests in `internal/httpapi/shelves.go` and related tests

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — append the shelf mount using the existing `catalog.Service`
- `go.mod` / `go.sum` — only if a directly required dependency is missing
- [progress/README.md](../progress/README.md) — edit only the SH1 row and append an SH1 log

**Must not touch:**
- Migrations, C1 book visibility behavior, or existing catalog DTO/API behavior
- Search, OPDS, catalog web UI, or W4 search/shelves UI
- `internal/httpapi/catalog.go` unless a small route-registration change is unavoidable;
  prefer a separate `ShelfMount` in the new handler file

## Requirements

1. Implement authenticated shelf routes using the current session, `httpapi.Mount`, and
   cookie-origin protection for every unsafe request:
   - `GET /api/v1/shelves` lists the viewer's private shelves and all shared shelves; an
     admin can also list all private shelves.
   - `POST /api/v1/shelves` creates a private shelf for the viewer, or a shared shelf only
     for an admin. Accept `{ "kind": "private|shared", "name": "...",
     "description": null|string }`; derive `owner_id` and `created_by` from the authenticated
     viewer.
   - `GET /api/v1/shelves/{id}` returns shelf metadata.
   - `PATCH /api/v1/shelves/{id}` updates name/description; `DELETE` removes the shelf.
   - `GET /api/v1/shelves/{id}/books?limit=...&cursor=...` returns visible books in manual
     shelf order.
   - `PUT /api/v1/shelves/{id}/books/{bookID}` adds a visible book, accepting an optional
     non-negative `position`; when omitted, append it. Repeating the request is
     idempotent. `DELETE` on that route removes the book.
2. Use the existing `shelves` and `shelf_books` schema; no migration is expected. Private
   shelf names are unique case-insensitively per owner and shared names globally. Map
   conflicts to 409, invalid inputs to 400, nonexistent/inaccessible shelves or books to
   404, and unauthorized operations to the existing 403 behavior. Enforce schema limits in
   service validation rather than relying on SQLite errors.
3. Enforce ownership and visibility on every operation. A user can read shared shelves and
   their own private shelves, but cannot modify shared shelves or another user's private
   shelves. Admins can manage any shelf. Adding a book requires it to be visible to the
   viewer under the exact C1 access-plus-hide predicate; never let an admin bypass a hide
   entry through shelf membership.
4. Keep positions deterministic and contiguous when inserting, moving, removing, or
   reordering entries. Perform each mutation transactionally; prevent duplicate shelf-book
   membership and avoid lost/repeated books when positions tie. Do not expose hidden or
   inaccessible books in shelf lists, visible counts, or error details. A hidden member may
   remain stored but must be filtered until it becomes visible again.
5. Return the standard bounded page envelope for shelf lists and book lists (default 50,
   maximum 100). Use stable opaque cursors bound to viewer, shelf, and list order. Include
   visible-book counts, not raw membership counts. Reuse C1's hydrated `catalog.Book`
   representation for visible shelf entries rather than creating a second book DTO.
6. Document exported shelf types and JSON fields. Reject unknown JSON fields and malformed
   query parameters using existing HTTP conventions. Keep database work in the service,
   use sqlc queries, and explicitly map internal errors to problem responses.
7. Add service and HTTP tests for private/shared creation and listing, owner/admin
   permissions, duplicate names, CRUD, idempotent add/remove, insertion and reorder
   positions, cursor bounds, pagination, hidden/inaccessible books, and visibility changes.
   Include tests proving that raw hidden-book counts are not exposed.

## Out of scope

- Shelf/search result integration (O1, W4)
- Shelf web UI (W4)
- Catalog visibility-rule changes or schema migrations
- Import, metadata, or admin pages (I1, M1, W5)

## Acceptance criteria

- [x] Private and shared shelf visibility and management rules are enforced and tested.
- [x] Manual order survives add, move, remove, and pagination without skips or duplicates.
- [x] Hidden/inaccessible books are filtered from lists and counts for all viewer roles.
- [x] No migration is added.
- [x] `task sqlc:check`, `task build`, `task lint`, and `task test` pass.

## Validation commands

```powershell
task sqlc:check
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and SH1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Document the shelf response and ordering contract for O1 and W4.
- Update architecture docs or add an ADR only if the accepted design changes.

### Shelf API contract for O1 and W4

- All shelf endpoints require a browser session; unsafe requests also require cookie-origin
  protection. Readers see their own private shelves and all shared shelves; admins also see
  other users' private shelves and may manage every shelf. Only admins create or modify
  shared shelves. A private shelf belonging to someone else is indistinguishable from a
  nonexistent shelf (404); an accessible shelf that the viewer cannot modify returns 403.
- `POST /api/v1/shelves` accepts `kind`, `name`, and nullable `description`; owner and
  creator are taken from the session. Names are trimmed, nonempty, at most 1024 UTF-8 bytes
  and unique under SQLite's ASCII `NOCASE` collation per private owner or globally for
  shared shelves. Descriptions are nullable and at most 1 MiB. `PATCH` accepts `name`
  and/or `description`, with explicit null clearing the description.
- Create returns 201 and `GET`/`PATCH` return 200 with `{"shelf":{...}}`. A shelf has
  `id`, `kind`, nullable `owner_id`, `name`, nullable `description`, nullable `created_by`,
  `visible_book_count`, `created_at`, and `updated_at`. Timestamps are UTC RFC 3339.
  `DELETE` returns `{"deleted":true}`. Counts always apply the viewer's library grants
  and hide list; even an admin does not bypass their own hide list.
- `GET /api/v1/shelves` sorts by `(name COLLATE NOCASE, id)`. Both shelf and shelf-book
  lists use `{"items":[...],"next_cursor":null|string}`, default `limit=50`, maximum 100,
  and viewer-bound opaque cursors. `GET /api/v1/shelves/{id}/books` returns the existing
  hydrated `catalog.Book` objects in manual order, not a separate shelf-book DTO.
- `PUT /api/v1/shelves/{id}/books/{bookID}` accepts an empty body or `{}` to append a new
  visible book; omitting the position for an existing member leaves it in place. An
  optional `{"position":N}` moves or inserts at the zero-based **visible** index, clamped
  to the end. Null and negative positions are invalid. Invisible members stay stored and
  retain their relative order; internal positions are normalized transactionally. A
  successful PUT returns `{"saved":true}`. DELETE returns `{"removed":true}` and is
  idempotent for a visible book, but a hidden, inaccessible, or nonexistent book is 404.
- Shelf-book cursors are bound to the viewer, shelf, and visible order, without exposing
  stored positions. If visible membership or order changes between pages, the old cursor
  returns 400; restart pagination. Invalid fields, query parameters, and cursors return
  400; name conflicts return 409.
