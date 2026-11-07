# BV2: Per-book reading log API – summary, sessions page, delete session

- Status: Ready
- Wave: 1. Dependencies merged: baseline `72c469c`
- Can run in parallel with: BV1, BV3, BV4
- Branch/worktree: `task/bv2` / `..\pandalibrary-bv2`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md): decisions 10 and 11, the
  `reading-summary`, `sessions` and session `DELETE` contract, the `summary` and
  `Session` shapes, the verification policy.
- `internal/reading/service.go` (`GetBookState`, `requireVisibleBook`, the
  `reading_sessions` push case), `internal/reading/types.go`,
  `internal/db/queries/reading.sql`, `internal/stats/service.go` (timezone
  calendar and day-bucket logic to reuse, not copy),
  `internal/httpapi/reading.go`, `internal/httpapi/reading_test.go`.
- `reading_sessions` and `user_books` in `internal/db/migrations/00001_init.sql`.

## Goal

The Details tab's "Your reading" card and the Reading Log tab can show a
book's per-user reading summary (totals, pace, estimate, records, derived
attempts, per-day series) and a filtered, paginated session history, and the
user can delete a wrongly recorded session.

## Scope

**Owns:** `internal/reading/booklog.go`, `booklog_test.go` (new; split further if
large), new queries appended to `internal/db/queries/reading.sql`, regenerated
sqlc output, the three routes and handlers added in
`internal/httpapi/reading.go`, and tests.

**Shared:** if the timezone/day-bucket helpers of `internal/stats` are not
exported, extract a small exported helper there (no behavior change; existing
stats tests must pass unchanged).

**Owns (web typed client for this contract):** `web/src/lib/bookview/log-api.ts`
and `log-api.test.ts` (new).

**Must not touch:** `internal/catalog/**` (BV1), the sync push/pull semantics,
migrations, any other `web/**` file.

## Subtasks

### BV2.1 – Queries and session model

> Append sqlc queries to `internal/db/queries/reading.sql`: (a) all of a
> viewer's sessions for a book ordered by `started_at, seq` (for the summary
> and attempt derivation; the visible-book check stays in the service), (b) a
> keyset page newest-first by `(started_at DESC, seq DESC)` with an optional
> `started_at >= ?` lower bound and a total count for the same filter, (c) a
> delete by `id AND user_id AND book_id`. Regenerate sqlc. Add a `Session` DTO
> exactly as in the plan (`change` is null unless both percentages are known;
> `attempt` is the derived attempt number).

### BV2.2 – Summary and attempt derivation

> Implement `Service.GetReadingSummary(ctx, viewer, bookID, timezone)` returning
> the plan's `summary` object. Validate the timezone with the same rules as
> `/api/v1/stats` (`ErrInvalid` → 400). Use `reading_progress.percentage` for
> `progress`. Compute totals, average, active days in the timezone, `span_days`
> (first to last active day inclusive), pace and estimate (formulas in the
> plan), records (the longest single session with its local date, the best
> day by seconds, the longest run of consecutive active days), the `days`
> series (ascending, at most 3,660 newest days) and `attempts` (decision 11:
> thresholds 0.95 and 0.10, the `user_books.finished_at` split, statuses
> `completed` / `in_progress` / `stopped`, newest first, with `sources` as the
> distinct session sources). Write the attempt derivation as a pure function
> with table tests: no sessions, a single attempt, a re-read after 100%, a
> re-read after `finished_at`, null percentages, and a backward jump that is
> **not** a new attempt (for example 54% → 2%, then back to 96%). Return 404 for
> an invisible book. Without sessions, return zero counts and empty arrays.

### BV2.3 – Sessions page and delete

> Implement `ListBookSessions(ctx, viewer, bookID, range, timezone, limit,
> cursor)`. `range` is one of `all` (default), `30d`, `90d`, `year` (calendar
> year start in the timezone). `limit` is 1-100 (default 25). The cursor is
> opaque and bound to range+timezone (a mismatch → 400), following the
> existing cursor helpers. Each item carries `attempt` from the same
> derivation, run over all sessions so numbers are stable across pages.
> Implement `DeleteBookSession(ctx, viewer, bookID, sessionID)`: owner-only. A
> session that is missing or belongs to another user → `ErrNotFound`. A session
> ID that is not a UUID → 400. Deleting does not bump sync revisions (sessions
> are not pulled). Add tests showing `/api/v1/stats` totals drop after a
> delete.

### BV2.4 – HTTP

> In `internal/httpapi/reading.go`, add `GET
> /api/v1/me/books/{id}/reading-summary`, `GET /api/v1/me/books/{id}/sessions`
> and the cookie-protected `DELETE /api/v1/me/books/{id}/sessions/{sessionId}`
> (`204`). Validate query parameters strictly, like the existing handlers:
> unknown or duplicate parameters → 400. Send `Cache-Control: no-store` on the
> GETs. Use problem responses for 400/401/403/404. HTTP tests cover each
> endpoint's happy path, validation errors, another user's session (404), an
> invisible book (404), CSRF protection on DELETE, and pagination with a cursor
> over 30 sessions.

### BV2.5 – Typed web client

> Create `web/src/lib/bookview/log-api.ts` with readonly TS types
> `ReadingSummary`, `Attempt`, `ReadingRecords`, `ReadingDay`, `BookSession`,
> `SessionRange`, and the functions `viewerTimezone()` (resolved IANA zone, falls back
> to `UTC`), `getReadingSummary(bookId, { timezone?, signal? })`,
> `listBookSessions(bookId, { range, cursor, limit, timezone, signal })` →
> `Page<BookSession> & { total }`, and `deleteBookSession(bookId, sessionId)`.
> Use the shared `api` client (`ApiError` on failures). Also add
> `addManualSession(bookId, { startedAt, endedAt, activeSeconds,
> startPercentage, endPercentage })`, which pushes a `reading_sessions` upsert
> via `pushMutation` (UUIDv7, `source: 'web'`, `device: 'Manual entry'`) per
> decision 10. Unit-test the paths, query strings and parsing in
> `log-api.test.ts` with a mocked fetch. BV6 and BV8 import this file.

### BV2.6 – Document

> Add the endpoints and the attempt rule to
> [architecture/system.md](../architecture/system.md). Note in the plan any
> deviation from the contract.

## Out of scope

UI (BV6, BV8), a stored attempts model, editing sessions (only add via
`/sync/push` and delete here).

## Acceptance criteria

- [ ] All three endpoints match the plan contract. The attempt derivation is a
      pure, table-tested function.
- [ ] Timezone-correct day bucketing (test with a non-UTC zone across midnight).
- [ ] No migration. Existing reading/stats tests are unchanged and pass.

## Validation commands (targeted only)

```powershell
task sqlc:check
go test ./internal/reading/... ./internal/stats/... ./internal/httpapi/...
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview/log-api.test.ts
```

## Hand-off

Set this prompt to Done, update the BV2 row and log in
[progress/README.md](../progress/README.md), and record any contract changes
in the plan for BV6/BV8.
