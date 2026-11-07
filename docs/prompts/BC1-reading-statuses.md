# BC1: Extended reading statuses, status icons, Image-3 status menu

- Status: Done
- Wave: 1. Dependencies merged: baseline (`6a6709b`)
- Can run in parallel with: BC2, BC3
- Branch/worktree: current `master` worktree, uncommitted (`task/bc1` was not created)
- Migration: **yes** (`00005_reading_statuses.sql`)

## Read first

- [Book Cover plan](../plans/book-cover-plan.md): decisions 1 and 2, the
  "Status kit" contract.
- `internal/db/migrations/00001_init.sql` (`user_books` around line 250, its
  CHECK constraint and the indexes `user_books_user_rev`,
  `user_books_user_status`), `00004_bookheap.sql` (style of the latest
  migration), `migrations.go`, `migrations.sum`, `migrations_test.go`.
- Status consumers: `internal/reading/service.go` (~line 500 validation),
  `internal/catalog/shelf_rules.go` (~line 34),
  `internal/db/queries/dashboard.sql` (continue_reading excludes
  `finished/abandoned`; the read section), `internal/db/queries/stats.sql`
  (books finished), `internal/opds/handler.go` (`statusReading`).
  Run `rg -n "'(finished|reading|abandoned)'|\"(finished|reading|abandoned)\"" internal`
  for any other consumer, including KOReader sync.
- Web: `web/src/lib/bookview/user-book.ts` (`READ_STATUSES`,
  `readStatusLabel`, `statusPatch`), `ReadStatusMenu.svelte`, `Icon.svelte`
  (inline-SVG style), and the `reread` call sites:
  `details/DetailsHero.svelte` (lines ~100-102), `tabs/DetailsTab.svelte`
  (~150), `log/LogSummary.svelte` (~41), `kit-fixture.svelte` (~37).
- Pasted Image 3: a white rounded menu; each row has a coloured outline icon,
  a label, and a teal check on the selected row. The hovered row is light
  grey.

## Goal

Users can pick any of the 8 statuses in Image 3. Each status has one icon
and colour that later tasks reuse on cover badges.

## Scope

**Owns:** the new migration (+ `migrations.sum`), the status lists/validation
in the Go files above, `dashboard.sql` (+ regenerated sqlc), `user-book.ts`
(+ test), `ReadStatusMenu.svelte`, new `web/src/lib/bookview/StatusIcon.svelte`,
the `reread` call sites, and `bc1.*` messages.

**Must not touch:** `BookCover`, `CoverActions`, `BookCard`, `cover.ts`
(BC3/BC4), and the reading log attempt derivation (it stays as history).

## Subtasks

### BC1.1 – Data model

> Add `00005_reading_statuses.sql` (`task migrate:new NAME=reading_statuses`,
> then `task migrate:sum` after editing). SQLite cannot alter a CHECK, so rebuild
> `user_books` inside the goose transaction: create `user_books_new` with the
> same columns/PK/`WITHOUT ROWID` and
> `CHECK (status IN ('unread','want_to_read','reading','on_hold','rereading','finished','skimmed','abandoned'))`,
> copy the rows, drop the old table, rename, and recreate both indexes. The
> Down migration maps `on_hold→reading`, `rereading→reading`,
> `skimmed→finished` and restores the old CHECK. Extend `migrations_test.go`: up and down
> round-trip, and the new values are accepted after up.

### BC1.2 – Server semantics

> Accept the new statuses in `reading/service.go` validation and in
> `shelf_rules.go`. In `dashboard.sql`, continue_reading keeps excluding
> finished/abandoned and also excludes `skimmed`. The "read" section includes
> `skimmed`. `on_hold`/`rereading` are in progress. The OPDS "Reading now"
> feed includes `reading`, `rereading` and `on_hold`. Stats "books finished"
> stays `finished` only. Regenerate sqlc (`task sqlc`). Add one Go test for each changed rule (dashboard, OPDS, smart
> shelf rule, push validation).

### BC1.3 – Web status kit

> In `user-book.ts`, set `READ_STATUSES` to the Image 3 order
> `['unread','want_to_read','reading','on_hold','rereading','finished','skimmed','abandoned']`.
> `readStatusLabel(status)` drops the `reread` parameter (labels: Unread, Want
> to read, Reading, On hold, Re-reading, Read, Skimmed, Abandoned, plus zh).
> `statusPatch` sets `started_at` for `rereading` like `reading` (a re-read
> resets `started_at` to now and clears `finished_at` in the preview). Add
> `statusTone(status)` returning Tailwind classes:
> unread `text-slate-500`, want_to_read `text-violet-600`, reading
> `text-blue-600`, on_hold `text-amber-500`, rereading `text-fuchsia-600`,
> finished `text-green-600`, skimmed `text-sky-500`, abandoned `text-rose-600`.
> Create `StatusIcon.svelte` (`{ status, class? }`, inline 24x24 stroke SVG
> in `Icon.svelte`'s style): unread closed book; want_to_read book with a
> bookmark ribbon; reading open book; on_hold two vertical rounded bars;
> rereading counter-clockwise circular arrow; finished book with a check;
> skimmed dashed corner-bracket frame with a centre line; abandoned book with
> an x. Update `user-book.test.ts`.

### BC1.4 – Menu and call sites

> In `ReadStatusMenu.svelte`, each option renders
> `<StatusIcon>` (tone colour, `size-5`), the label, and a right-aligned
> emerald/teal check (`✓` → an SVG check) when selected, as in Image 3. Use a
> `rounded-xl` panel, `p-1.5`, `gap-3` rows, `py-2.5`, and a `bg-slate-100`
> hover/focus row. Add `variant: 'badge'`: a 28 px white round chip trigger
> with `StatusIcon` in the tone colour and `shadow-sm ring-1 ring-black/5`.
> Its accessible name is `bc1.status_badge` ("Reading status: {status}.
> Change"). The menu opens below-right of the chip, flips up when there is no
> room (reuse BV5's upward override approach), and is clamped inside the
> viewport. The pill and icon triggers show the current status icon instead
> of the eye. Remove the `reread` prop everywhere and update the 4 call sites.
> Keep the keyboard model (Arrow keys, Home/End, Escape restores focus).

## Out of scope

Cover badges (BC4) and tile data loading (BC2).

## Acceptance criteria

- [x] Old rows keep their status after migration. All 8 values round-trip
      through `/sync/push` and `/sync/pull`.
- [x] The menu matches Image 3 (icons, colours, order, check) in en and zh.
- [x] Dashboard/OPDS/shelf rules follow decision 1, with tests.
- [x] No `reread` prop remains (`rg -n '\breread\b' web\src\lib` finds no
      matches; `rereading` is a valid status).

## Validation commands (targeted only)

```powershell
task sqlc:check
go test ./internal/db/... ./internal/reading/... ./internal/catalog/... ./internal/opds/... ./internal/httpapi/...
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/details/details.e2e.ts src/lib/bookview/log/log.e2e.ts
```

## Hand-off

Set this prompt to Done, update the BC1 row/log in
[progress/README.md](../progress/README.md), and record the final
`StatusIcon`/`statusTone`/`variant="badge"` API for BC4.
