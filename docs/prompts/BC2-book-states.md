# BC2: Batched book-states API and client store

- Status: Done
- Wave: 1. Dependencies merged: baseline (`6a6709b`)
- Can run in parallel with: BC1, BC3
- Branch/worktree: `task/bc2` / `..\pandalibrary-bc2`
- Migration: no

## Read first

- [Book Cover plan](../plans/book-cover-plan.md): decision 7 and the "Book
  states" contract.
- `internal/httpapi/reading.go` (route registration, `getBookState`),
  `internal/reading/service.go` (how `/me/books/{id}` loads `user_book` and
  `progress`), `internal/db/queries/reading.sql`,
  `internal/db/queries/dashboard.sql` (the library-access and `book_hidden`
  filter pattern you must reuse).
- Web: `web/src/lib/reader/api.ts` (`getBookState`, typed client style),
  `web/src/lib/api/client.ts` (`ApiError`), `web/src/lib/sync/db.ts`
  (`rows(account)`, `outbox`), `web/src/lib/sync/state.ts`
  (`replayMutations`), `web/src/lib/sync/client.ts` (`currentAccount`,
  `offlineAvailable`), `web/src/lib/bookview/events.ts`
  (`BOOK_STATE_CHANGED_EVENT`), `web/src/lib/dashboard/resume.ts` (online,
  offline and session-lock pattern).

## Goal

Any grid of covers can get every visible book's status and reading
percentage with one request per batch, online or offline, and stays fresh
when a status or progress changes.

## Scope

**Owns:** `internal/reading/states.go` + `states_test.go` (new), the query
appended to `internal/db/queries/reading.sql` (+ sqlc), one route line and a
handler in `internal/httpapi/reading.go` (+ test),
`web/src/lib/bookview/book-states.svelte.ts` + `book-states.test.ts` (new).

**Must not touch:** `catalog.Book` / list DTOs, cover components.

## Subtasks

### BC2.1 – API

> `GET /api/v1/me/book-states?ids=1,2,3` (session auth like the other `/me`
> routes). Parse the comma list; reject an empty list, more than 100 IDs, or
> non-positive or non-integer values with a 400 problem. Deduplicate. Run one
> SQL query: the requested IDs `LEFT JOIN user_books` and `LEFT JOIN
> reading_progress` for the viewer, filtered by library access (admins see
> all) and `book_hidden`. Return only rows where either side exists:
> `{ items: [{ book_id, status, percentage, book_file_id, updated_at }] }`.
> `status` defaults to `"unread"` when there is no `user_books` row.
> `percentage` and `book_file_id` are null without progress. `updated_at` is
> the max of both (RFC3339 UTC). Treat status as an opaque validated string
> from the DB, so BC1's new values pass through. Tests: ACL (an inaccessible
> library is omitted), a hidden book is omitted, the limits, the dedupe, a mix
> of rows, and another user's rows are never returned.

### BC2.2 – Client store

> `book-states.svelte.ts` exports `bookState(bookId)`, which returns a
> reactive `{ status: ReadStatus; percentage: number | null; loading: boolean }`.
> It also exports `refreshBookStates(ids?: number[])` and
> `getBookStates(ids, signal)` (the raw typed client). The store coalesces
> every `bookState` call made in the same microtask into one request per 100
> IDs. It caches per `currentAccount()`, clears on account change, and drops
> stale responses with a version counter. Validate statuses with
> `READ_STATUSES` from `user-book.ts`; an unknown status → `unread`. Refresh
> the affected ID on `BOOK_STATE_CHANGED_EVENT`, everything cached on the
> sync-pull completion event (find the existing one in `sync/`; if none
> exists, on `online` + `visibilitychange` visible), and keep the cache across
> navigation. When `offlineAvailable()` and the network fails or is offline,
> resolve from IndexedDB `rows` (`user_books`, `reading_progress`) with
> pending outbox mutations replayed (reuse `replayMutations` semantics).
> Without offline storage and when offline, return `{status:'unread',
> percentage:null, loading:false}` silently. Unit tests: coalescing (3 calls →
> 1 fetch), chunking at 100, invalidation by event, the account switch, the
> offline fallback with a pending outbox status change, and stale response
> suppression.

## Out of scope

Rendering badges or progress (BC4).

## Acceptance criteria

- [x] One request per rendered page of 50 covers (verified in the unit
      test and noted for BC8's E2E).
- [x] No N+1 per-book `/me/books/{id}` calls from grids.
- [x] ACL and hidden-book rules match the dashboard queries.

## Validation commands (targeted only)

```powershell
task sqlc:check
go test ./internal/reading/... ./internal/httpapi/...
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview/book-states.test.ts
```

## Hand-off

Set this prompt to Done, update the BC2 row/log, and record the final
store API for BC4.
