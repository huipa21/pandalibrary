# R1: Reading and sync API

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § R1
- Depends on (merged): C1
- Can run in parallel with: W1, X2, X3
- Branch / worktree: `task/r1` in `..\pandalibrary-r1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 5–6, 8, 10, 15
- [architecture/database.md](../architecture/database.md) §§1–3, 5–9
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md), and
  [ADR-0006](../decisions/0006-koreader-sync-compat.md)
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- `internal/db/migrations/00001_init.sql`, the generated `internal/db/sqlc` package,
  `internal/db/db.go`, `internal/catalog/service.go`, and `internal/httpapi/auth.go`
- F4's `httpapi.Mount` convention and the merged C1 app wiring and catalog visibility
  behavior

## Goal

Implement per-user reading state, annotations, settings, and reading-session APIs on the
existing schema. Support consistent, idempotent offline push/pull with server revisions
and last-write-wins semantics, while preventing reads and writes for books the authenticated
user cannot currently see.

## Scope

**Owns (create/modify freely):**
- `internal/reading/**`
- `internal/db/queries/reading.sql`
- Reading and sync HTTP handlers and tests under `internal/httpapi/reading*.go`
- Reading/sync-specific tests in the owned packages

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — construct the reading service and append its HTTP mount
- `internal/httpapi/routes.go` — append/register routes through the existing `Mount` pattern
- `internal/db/sqlc/**` — generated output only; run `task sqlc`
- `go.mod` / `go.sum` — only if a directly required dependency is missing
- [progress/README.md](../progress/README.md) — edit only the R1 row and append an R1 log

**Must not touch:**
- `internal/db/migrations/**`; the initial migration already contains the required tables
- `internal/catalog/**`, `internal/auth/**`, and existing auth/catalog routes
- `internal/search/index.go` for book indexing, importer, KOReader protocol adapter, or
  web UI
- Other tasks' query files or generated sqlc files by hand

## Requirements

1. Use the existing writer and reader pools, `db.WithTx`, `db.NextRev`, sqlc-generated
   queries, and the `reading` service layer. HTTP handlers must not call sqlc directly.
   Never accept a user ID or admin flag from request data; derive identity from
   `httpapi.ViewerFromRequest`.
2. Implement authenticated per-book state at `GET /api/v1/me/books/{id}`. Return a named
   object containing this user's `user_book` and `progress` (nullable), plus `highlights`
   and `notes` arrays of live rows. Return 404 for both nonexistent and currently
   inaccessible books. Include only the current user's records and never expose
   tombstoned annotations as live content.
3. Implement `GET /api/v1/me/settings` for the authenticated user's settings. Keep the
   response shape and JSON value types documented in Go DTOs. Settings values must be
   valid JSON, bounded in size, and scoped to the current user.
4. Implement `POST /api/v1/sync/push` and `GET /api/v1/sync/pull?cursor=N` as specified
   in [system.md](../architecture/system.md) §10 and
   [database.md](../architecture/database.md) §6:
   - Push accepts at most 500 mutations with `entity`, `id` or natural key, `op`,
     `data`, and integer Unix-millisecond `updated_at`. Use the authenticated user for all
     ownership checks. Return one `applied`, `stale`, or `rejected` result per input
     mutation; invalid individual mutations must not be reported as applied.
   - Support the synced tables `user_books`, `reading_progress`, `highlights`, `notes`,
     and `user_settings`. Accept `reading_sessions` as upload-only, append-only records
     with client UUIDv7 IDs and `INSERT OR IGNORE` idempotency; sessions are not part of
     pull. Do not sync raw `kosync_progress`.
   - Clamp client timestamps to server time. For LWW rows, a strictly newer timestamp
     wins; ties are stale. Call `db.NextRev` for each applied synced write and keep the
     revision increment and row/index changes in the same write transaction. Treat an
     applied session as append-only; it does not consume a sync revision.
   - Tombstone highlight and note deletes with `deleted_at` and `updated_at`; deleting a
     highlight tombstones its live notes in the same transaction. Keep FTS rows in sync
     with annotation mutations and never resurrect a tombstone with an older edit.
   - Do not add schema or invent tombstone storage. Reject unsupported delete operations
     for rows whose existing schema cannot represent a deletion; clients can use an
     explicit upsert/reset where the schema supports it.
   - Validate the whole request envelope before writing. Apply valid mutations in one
     transaction. On a database/transaction failure, roll back and return an explicit
     problem response rather than a success-shaped result.
   - Pull in one read transaction: read the high-water `sync_counter`, then return this
     user's rows with `cursor < rev <= high_water` from each synced table and the
     high-water cursor. Include tombstones. Return stable arrays, including empty arrays.
     Reject malformed or negative cursors with 400.
5. Apply C1's book visibility rule to every book-derived reading query, sync push/pull row,
   session read/write, and annotation search. Reuse
   `catalog.Service.CheckVisible` where appropriate or put the equivalent predicate in
   SQL; extend the existing visibility test harness for each new query. A hidden or
   inaccessible book must not be exposed through progress, annotations, search results,
   or sync.
6. Implement `GET /api/v1/search/annotations?q=...` over the user's own live highlights
   and notes. Filter by user and book visibility before returning results. Use the
   existing trigram/short-query conventions from
   [database.md](../architecture/database.md) §8, escape LIKE wildcards, and keep FTS
   indexing transactional with annotation writes and deletes.
7. Mount all routes using F4's `httpapi.Mount`, `SessionMiddleware`,
   `ViewerFromRequest`, and cookie-origin protection for unsafe session-authenticated
   requests. Use the existing `application/problem+json` error mapping and request
   conventions. Preserve auth and catalog behavior.
8. Add real-SQLite service tests and HTTP tests for ownership, invisible books, LWW
   winners/ties, client-clock clamping, idempotent push, all-or-nothing transaction
   failures, consistent pull cursors/tombstones, highlight-delete note cascade, FTS
   maintenance, invalid cursors/payloads, and session append idempotency. Cover notes and
   highlights belonging to another user and annotation search's visibility filtering.

## Out of scope

- KOReader wire protocol and device behavior (K1)
- Reader UI, browser outbox, and offline storage (W2/W3)
- Stats aggregation, exports, and tombstone purging (ST1, E1, J1)
- Database schema changes or migration work

## Acceptance criteria

- [x] Per-book state and settings are authenticated, user-scoped, and visibility-filtered.
- [x] Push is bounded, validated, transactional, idempotent, and follows documented LWW,
  revision, tombstone, and session rules.
- [x] Pull returns a consistent snapshot with a monotonic high-water cursor and required
  tombstones; annotation search returns only visible live rows owned by the viewer.
- [x] Tests cover the required read, write, sync, FTS, visibility, and failure cases.
- [x] `task sqlc`, `task sqlc:check`, `task build`, `task lint`, and `task test` pass.
- [x] No migration or unrelated domain implementation is added.

## Validation commands

```powershell
task sqlc
task sqlc:check
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and R1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record the exact push/pull DTO contract and any sync limitations imposed by the existing
  schema for W2/W3 and K1.
- Update architecture docs or add an ADR only if the accepted design changes.

## Implementation hand-off

- `GET /api/v1/me/books/{id}` returns
  `{"user_book": object|null, "progress": object|null, "highlights": [], "notes": []}`.
  `GET /api/v1/me/settings` returns `{"settings":[{"key","value","updated_at","rev"}]}`;
  `value` remains a JSON value, and row timestamps are UTC RFC 3339 strings.
- Push is `{"mutations":[{"entity","id"|"key","op","data","updated_at"}]}` with integer
  Unix-millisecond `updated_at` and at most 500 entries. A successful response is
  `{"results":[{"index","status","reason?"}]}` with one `applied`, `stale`, or `rejected`
  result per mutation. `data` fields:
  - `user_books`: `book_id`, `status`, optional `rating`, `started_at`, `finished_at`;
    the natural key is the decimal book ID.
  - `reading_progress`: `book_id`, optional `book_file_id`, `source`, optional `locator`,
    `percentage`, optional `device`, `device_id`; the natural key is the decimal book ID.
  - `highlights`: `book_id`, optional `book_file_id`, `locator`, `position`, `text`, `color`,
    optional `chapter` and `created_at`; `id` is a UUIDv7.
  - `notes`: `book_id`, optional `highlight_id`, `body_md`, optional `created_at`;
    `id` is a UUIDv7.
  - `user_settings`: `value` (any valid JSON value up to 64 KiB); `key` is the setting key.
  - `reading_sessions`: `book_id`, `source`, `started_at`, `ended_at`, `active_seconds`,
    and optional device/percentage/page fields; `id` is a UUIDv7.
- Pull returns `{"cursor","user_books":[],"reading_progress":[],"highlights":[],"notes":[],
  "user_settings":[]}`. Annotation tombstones are included; reading sessions are never
  pulled and do not consume revisions. Pull filters book-derived rows against current book
  visibility, so clients must discard local state when they lose access.
- The existing schema has no delete representation for `user_books`, `reading_progress`,
  or `user_settings`; `delete` is rejected for those entities. Clients reset supported
  state with an upsert (for example `status:"unread"` or `percentage:0`). Highlights and
  notes delete via tombstones; deleting a highlight tombstones its live notes. Sessions
  are append-only upserts and duplicate IDs return `stale`.
