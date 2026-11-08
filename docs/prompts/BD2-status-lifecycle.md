# BD2: Automatic reading-status lifecycle and re-read restart

- Status: Done
- Wave: 1. Dependencies merged: baseline (`d6014b0`)
- Can run in parallel with: BD1, BD3, BD4, BD5, BD6
- Branch/worktree: `task/bd2` in `..\pandalibrary-bd2`
- Migration: **yes**, `00006_status_lifecycle.sql` (number reserved; BD3 owns
  00007). **Merge BD2 before BD3.**

## Read first

- [Book Detail plan](../plans/book-detail-plan.md): R10 and decision 10, the
  "Status lifecycle" contract.
- `internal/reading/service.go` `applyMutation` (`user_books` case ~line 487,
  `reading_progress` case ~line 560): validation, `readClock`, LWW
  `updatedAt`, `db.NextRev(ctx, tx)`, `writeResult`.
- `internal/db/queries/reading.sql` (`ReadingUpsertUserBook`,
  `ReadingUpsertProgress`, the clock queries), `internal/db/sqlc/` (generated;
  run `task sqlc`).
- `internal/kosync/service.go` `Put` → `reading.PushTx` (KOReader takes the
  same path; do not add a second rule there).
- `internal/reading/booklog.go` `deriveAttempts` (+ `booklog_test.go`). Find
  where the summary passes `finishedAt` and where it can read `started_at`.
- Migrations: `00005_reading_statuses.sql` (style), `migrations.go`,
  `migrations.sum`, `migrations_test.go`; `task migrate:new NAME=…`,
  `task migrate:sum`.
- Web: `web/src/lib/bookview/user-book.ts` (`statusPatch`), and
  `web/src/lib/sync/state.ts` `replayMutations` (used by
  `readerState` and `bookview/book-states.svelte.ts`) + its tests.
- Statuses: `unread, want_to_read, reading, on_hold, rereading, finished,
  skimmed, abandoned` (BC1). "Read" is the label for `finished`.

## Goal

The status follows reading automatically. Unread becomes Reading when
progress starts and Read when the book is finished. Manual statuses are kept.
Choosing Re-reading restarts the progress and starts a new attempt. This
works for web and KOReader progress, for existing data, and in offline
displays.

## Scope

**Owns:** the two `applyMutation` cases above, new
`internal/reading/lifecycle.go` (+ `lifecycle_test.go`), `booklog.go`
(+ test), queries appended to `reading.sql` (+ regenerated sqlc), the
00006 migration (+ `migrations.sum`, migration test), `user-book.ts`
(+ test), `sync/state.ts` (+ test), and `bd2.*` messages (probably none).

**Must not touch:** UI components (`ReadStatusMenu`, `DetailsHero`…: BD4/BD7),
review files (BD3), and the KOReader protocol code.

## Subtasks

### BD2.1 – Pure rules (Go)

> In `lifecycle.go`: `const AutoFinishThreshold = 0.99` and
> `func autoStatus(current string, hasRow bool, percentage float64) (next string, changed bool)`
> implementing decision 10:
> - no row/`unread`/`want_to_read` with `p > 0` → `reading`;
> - `unread`/`want_to_read`/`reading`/`rereading` with `p ≥ 0.99` → `finished`
>   (this rule wins over the first);
> - `on_hold`/`skimmed`/`abandoned`/`finished` → unchanged.
>
> Table-test every status × {0, 0.001, 0.5, 0.989, 0.99, 1}.

### BD2.2 – Progress → status (server)

> In the `reading_progress` case, after an **applied** upsert (rows == 1,
> not stale), read the current `user_books` row (add `ReadingGetUserBookForUpdate`
> or reuse an existing getter) and call `autoStatus`. When it changes, write
> it with a new query `ReadingAutoUpdateUserBookStatus`. It upserts
> `status`, `started_at = COALESCE(started_at, :now)` and, for `finished`,
> `finished_at = :now`. It sets `updated_at = :now` (server ms) and
> `rev = NextRev` **only when** `:now > user_books.updated_at` (insert when
> there is no row; keep `rating`). Same visibility filters as
> `ReadingUpsertUserBook`. The push response must not report an extra
> mutation result; the change reaches clients through `/sync/pull` because of
> the new rev. Tests: web push 0 → 0.07 makes `reading` and sets
> `started_at`; 0.995 makes `finished` with `finished_at`; `on_hold` and
> `abandoned` stay; a stale progress push changes nothing; a client
> `user_books` write with a newer `updated_at` is not overwritten; a KOReader
> `Put` (kosync test fixture) triggers the same rule; pull returns the
> changed `user_books` row.

### BD2.3 – Re-read restart

> In the `user_books` case, read the previous status before the upsert.
> When the applied upsert sets `rereading` and the previous status was not
> `rereading`, reset the user's `reading_progress` row for that book with a
> new query `ReadingResetProgress` (`percentage = 0`, `locator = NULL`, keep
> `book_file_id`/`source`/`device`/`device_id`, `updated_at = :now`, new
> `rev`). Skip it if there is no progress row. In `booklog.go`, add an input
> `restartAt *int64` (the `user_books.started_at` when present). A new attempt
> starts at the first session whose `StartedAt ≥ restartAt` when the current
> attempt began before `restartAt`. Thread it from the summary/sessions
> loaders. Tests: finished at 100% → set `rereading` → progress row is 0 with
> a new rev and no locator; the next sessions form attempt 2; reaching 0.99
> → `finished` again; setting `rereading` while already `rereading` does not
> reset; the existing `deriveAttempts` cases still pass.

### BD2.4 – Backfill migration 00006

> `task migrate:new NAME=status_lifecycle`. In **Up**, within the goose
> transaction:
> 1. Build a temp table of `(user_id, book_id, new_status, p,
>    progress_updated_at)` from `reading_progress` LEFT JOIN `user_books`
>    where `percentage > 0` and the status is NULL, `unread` or
>    `want_to_read`, or the status is `reading`/`rereading` with
>    `percentage ≥ 0.99`.
> 2. Number the rows with `row_number() OVER (ORDER BY user_id, book_id)`
>    and add the current `sync_counter.value` to get each `rev`.
> 3. Upsert `user_books` (`started_at = COALESCE(started_at,
>    progress_updated_at)`, `finished_at` for finished =
>    `COALESCE(finished_at, progress_updated_at)`, `updated_at = MAX(existing,
>    progress_updated_at) + 1`).
> 4. Advance `sync_counter` by the row count.
>
> **Down** is a no-op that is documented: statuses are data and stay valid.
> Run `task migrate:sum`. In `migrations_test.go`, seed a pre-00006 database
> (no row with 0.3, `unread` with 0.995, `want_to_read` with 0.5, `on_hold`
> with 0.5, `reading` with 1.0, `unread` with 0). After Up, the statuses are
> `reading`, `finished`, `reading`, `on_hold`, `finished`, `unread`. Revs are
> unique and above the old counter, and the counter has advanced.

### BD2.5 – Web mirror

> In `user-book.ts`, export `AUTO_FINISH_THRESHOLD = 0.99` and
> `autoStatus(current: ReadStatus | null, percentage: number): ReadStatus | null`
> (the same table as Go; null = no change). In `sync/state.ts`
> `replayMutations`, after replaying a `reading_progress` upsert for the book,
> apply `autoStatus` to the replayed user book (create one when it is
> missing, as the server would). After replaying a `user_books` upsert that
> moves into `rereading` from another status, set the replayed progress to
> percentage 0 and locator null. Do not change what gets queued. Tests in
> `user-book.test.ts` and the `state` tests, plus one
> `book-states.test.ts` offline case: a queued progress of 0.4 on an unread
> book reads as `reading`.

## Acceptance criteria

- [x] R10: Unread → Reading on first progress; Reading/Re-reading → Read at
      ≥ 99%; manual states unchanged; re-read resets progress and starts a
      new attempt. This works for web, KOReader and offline displays.
- [x] Existing libraries are corrected by 00006, and clients pull the
      corrected rows.
- [x] LWW is safe: a newer client status write is never overwritten.
- [x] Go and web tests above pass. `task sqlc:check` is clean.

## Validation commands (targeted only)

```powershell
task sqlc:check
go test ./internal/db/... ./internal/reading/... ./internal/kosync/... ./internal/httpapi/...
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview/user-book.test.ts src/lib/bookview/book-states.test.ts src/lib/sync
```

## Hand-off

Set this prompt to Done, update the BD2 row/log in
[progress/README.md](../progress/README.md), and note the final query names,
the threshold, and whether the push response or the pull changed shape (it
should not).

Implemented on 2026-11-08. New queries: `ReadingAutoUpdateUserBookStatus`
and `ReadingResetProgress`; the existing `ReadingGetUserBook` reads the
current status within the write transaction. The completion threshold is
`0.99` in Go, TypeScript and migration 00006. Push/pull response shapes are
unchanged: derived status writes and re-read resets receive their own revisions
and arrive through the existing pull arrays. Entering Re-reading without a
start date also initializes it from the accepted mutation timestamp.
