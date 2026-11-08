# BD8: Integration, real-server E2E, visual QA, docs, full gate

- Status: Done (2026-11-09)
- Wave: 3 (alone). Dependencies merged: BD1-BD7
- Can run in parallel with: none
- Branch/worktree: `master` (integrated worktree)
- Migration: no (BD2's 00006 and BD3's 00007 must already be merged, in that
  order)

## Read first

- [Book Detail plan](../plans/book-detail-plan.md): requirements R1-R13, all
  decisions, and the reference screenshot
  [book-detail-before.png](../plans/assets/book-detail-before.png) (the
  "before" state; every red-boxed element must be gone or changed).
- Every BD hand-off in [progress/README.md](../progress/README.md).
- `web/src/routes/bookview-real.e2e.ts` (the real-server pattern: seeding
  books, pushing mutations, two users), `docs/architecture/book-view.md`, and
  the API docs location used by earlier batches.

## Goal

All BD branches are merged and consistent, verified end to end against a
real server, documented, and the full gate is green.

## Subtasks

### BD8.1 – Merge and seams

> Merge `task/bd1` … `task/bd7` (BD2 before BD3; re-run `task migrate:sum`
> and `task sqlc` if needed). Expected seams:
> - message key unions in `en.json`/`zh.json`;
> - remove the keys that are now unused: `bv4.back`, `bv4.back_label`,
>   `bv4.tabs.reading_log`, `bv6.synopsis`, `bv6.no_synopsis`,
>   `bv6.personal_review`, `bv6.your_review`, `bv6.reading` and the other
>   `ReadingCard`-only keys, `catalog.book.provenance` if unused,
>   `shelves.book.heading`/`select`/`choose` if unused, and whatever BD7
>   listed. Check each with `rg` before deleting;
> - the remaining links to `/reading-log` (switch them to `/activities`);
> - `details.e2e.ts` hunks from BD4/BD6/BD7.
>
> Then run `rg -n "reading-log|SynopsisCard|ReadingCard|AddToShelf|backUsesHistory" web/src`.
> Only legacy parsing/redirect compatibility and its explicit regression
tests may match; active links and ordinary navigation tests use Activities.

### BD8.2 – Real-server E2E

> Add `web/src/routes/bookdetail-real.e2e.ts` (two users, an admin and a
> reader, both with access to one library; one shared shelf, one private
> shelf, and Favorites). Cover:
> 1. **R4:** Dashboard → book → Resume → reader Back → back icon lands on
>    `/` (this is the reported bug). Repeat from All Books (with a sort query)
>    and from a shelf. Edit metadata → Back to book → back icon returns to
>    the entry list. Previous/next shows only the entry list.
> 2. **R1/R2:** Add to shelf (popover) → the tag appears → X → confirm → the
>    DELETE persists after reload. The reader sees no X on the shared shelf.
> 3. **R5/R6:** the admin's Details pencil opens `/books/{id}/edit`; the
>    sources are listed in the Details card; there is no Metadata sources
>    card; there is no Edit metadata or Back to library under the cover.
> 4. **R7-R9:** there is no format chip under the title and no Personal review
>    link; the status control has no border.
> 5. **R10:** the reader pushes progress 0.07 → the status reads Reading
>    after reload (and on the dashboard tile badge). Progress 0.995 → Read.
>    Set On hold, then push 0.5 → still On hold. Set Re-reading on a Read
>    book → progress shows 0% and Resume starts at the beginning; Activities
>    shows a new attempt after the next session. A KOReader `PUT
>    /syncs/progress` for an unread book → Reading.
> 6. **R11-R13:** Overview heading. The admin writes a review via Plus; the
>    reader sees it, writes their own, and sees both (theirs pinned). The
>    admin deletes the reader's review. The reader's private book-level
>    note is **never** visible to the admin. There is no Your reading card,
>    and the tab is named Activities.
> 7. **Migration:** start the binary on a copy of a pre-BD database with
>    `unread` + 30% progress → the status is Reading, and `/sync/pull` from
>    an old cursor returns the row.

### BD8.3 – Visual QA

> Screenshots of the Details tab at 360, 768 and 1440 px, in light and dark
> themes: the rest state, the status menu open, the shelf popover open, the
> X visible on hover and on touch, the review editor open, and the Reviews
> card with three reviews plus "Show more". Compare with the reference
> screenshot and the plan's decisions. Fix spacing and contrast (the X badge
> and the inline status on the page background must meet 3:1 for UI
> components). Check keyboard-only flows (back icon, status menu, popover, X,
> Plus, edit/delete) and reduced motion.

### BD8.4 – Docs and gate

> - Update `docs/architecture/book-view.md` (Details tab layout, the origin
>   back navigation, shelf tags, the status lifecycle rules, the reviews
>   entity) and the API docs (`/books/{id}/reviews*`, the auto-status side
>   effect of progress pushes, and the re-read reset).
> - Consider an ADR "Reviews are a separate public entity; notes stay
>   private" (`docs/decisions/`, template).
> - Set the plan Status to Done in
>   [book-detail-plan.md](../plans/book-detail-plan.md) and
>   [plans/README.md](../plans/README.md).
> - Run the full gate.

## Acceptance criteria

- [x] R1-R13 verified on a real server, with screenshots attached.
- [x] No unused message keys or dead components remain.
- [x] Docs updated.
- [x] Full gate green.

## Validation commands (full gate)

```powershell
pnpm --dir web build
task sqlc:check lint test build
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
task build
$env:PANDA_E2E_BINARY = (Resolve-Path .\pandalibrary.exe).Path
pnpm --dir web test:e2e
```

The first web build supplies the Go embed. The second `task build` embeds the
final SPA before the real-server browser run. Without `PANDA_E2E_BINARY`,
Playwright skips the real-server specs.

## Hand-off

Fill in a gate table (as in BC8), set this prompt to Done, update the BD8
row and add a log entry in [progress/README.md](../progress/README.md), and
list any follow-ups (the plan's open questions).

### Integration and evidence (2026-11-09)

BD1–BD6 were already integrated on `master`; BD7 was present in the worktree.
BD8 integrates that assembly without reverting earlier work. No BD task
branches remain to merge. Migrations 00006 then 00007 and sqlc output match.

- Removed 31 unused English/Chinese message keys (including the old
  back/Reading Log, removed cards/form and obsolete finished label). Kept
  `bv6.your_review`, which now names the pinned public review.
- Switched normal Activities tests and the older real-server test off the
  legacy URL; kept the intentional redirect regression and parser.
- Updated the stale menu-layout assertion to open Account menu → Profile,
  matching the existing header instead of expecting the removed Settings link.
- Updated the real UX integration test's removed shelf select to the new
  popover. Full-gate language tests also exposed static `html[lang=en]`
  persisting after language changes. The client now sets document language
  and direction from the resolved locale on startup and after restoring
  online/offline account preferences, so the language picker and bilingual
  Details agree. All 13 shell/UX tests pass on the rebuilt binary.
- `bookdetail-real.e2e.ts` exercises R1–R13 on the embedded binary with admin
  and reader sessions, shared/private/Favorites shelves, origin-specific
  neighbors, confirmed persistent membership deletion, metadata sources,
  status thresholds, manual On hold, re-read reset/new attempt, KOReader,
  public review creation/pinning/moderation and private note isolation.
- A version-5 SQLite fixture is copied before starting the candidate binary.
  Unread + 30% progress becomes Reading with rev 3; pulling from cursor 2
  returns the backfilled row.
- Keyboard-only flows cover back, status, Add, X/confirmation, Plus,
  save/cancel, own edit and delete/focus recovery. Reduced motion removes
  the status chevron transition; measured inline-status and X foreground
  contrast is at least 3:1 in both themes.

The original [before screenshot](../plans/assets/book-detail-before.png)
was available and compared: text back link, hero format chip, Personal
review link, cover-area edit/back links, Synopsis/Your reading cards,
standalone sources and the bottom shelf form are gone or replaced.
At 768 px the layout retains two usable columns; at 360 px it has no
horizontal document overflow.

#### Persistent real-server screenshots

All 38 images are in [assets/bd8](../plans/assets/bd8). Reviews uses the
specified 20-item page size: screenshots show at least three reviews plus
Show more, and the test loads the twenty-first real author's review.

| Width/theme | Rest | Status menu | Shelf popover | Hover X | Editor | Reviews + Show more |
|---|---|---|---|---|---|---|
| 360 light | [rest](../plans/assets/bd8/bd8-360-light-rest.png) | [status](../plans/assets/bd8/bd8-360-light-status.png) | [shelf](../plans/assets/bd8/bd8-360-light-shelf.png) | [hover](../plans/assets/bd8/bd8-360-light-hover.png) | [editor](../plans/assets/bd8/bd8-360-light-editor.png) | [reviews](../plans/assets/bd8/bd8-360-light-reviews.png) |
| 360 dark | [rest](../plans/assets/bd8/bd8-360-dark-rest.png) | [status](../plans/assets/bd8/bd8-360-dark-status.png) | [shelf](../plans/assets/bd8/bd8-360-dark-shelf.png) | [hover](../plans/assets/bd8/bd8-360-dark-hover.png) | [editor](../plans/assets/bd8/bd8-360-dark-editor.png) | [reviews](../plans/assets/bd8/bd8-360-dark-reviews.png) |
| 768 light | [rest](../plans/assets/bd8/bd8-768-light-rest.png) | [status](../plans/assets/bd8/bd8-768-light-status.png) | [shelf](../plans/assets/bd8/bd8-768-light-shelf.png) | [hover](../plans/assets/bd8/bd8-768-light-hover.png) | [editor](../plans/assets/bd8/bd8-768-light-editor.png) | [reviews](../plans/assets/bd8/bd8-768-light-reviews.png) |
| 768 dark | [rest](../plans/assets/bd8/bd8-768-dark-rest.png) | [status](../plans/assets/bd8/bd8-768-dark-status.png) | [shelf](../plans/assets/bd8/bd8-768-dark-shelf.png) | [hover](../plans/assets/bd8/bd8-768-dark-hover.png) | [editor](../plans/assets/bd8/bd8-768-dark-editor.png) | [reviews](../plans/assets/bd8/bd8-768-dark-reviews.png) |
| 1440 light | [rest](../plans/assets/bd8/bd8-1440-light-rest.png) | [status](../plans/assets/bd8/bd8-1440-light-status.png) | [shelf](../plans/assets/bd8/bd8-1440-light-shelf.png) | [hover](../plans/assets/bd8/bd8-1440-light-hover.png) | [editor](../plans/assets/bd8/bd8-1440-light-editor.png) | [reviews](../plans/assets/bd8/bd8-1440-light-reviews.png) |
| 1440 dark | [rest](../plans/assets/bd8/bd8-1440-dark-rest.png) | [status](../plans/assets/bd8/bd8-1440-dark-status.png) | [shelf](../plans/assets/bd8/bd8-1440-dark-shelf.png) | [hover](../plans/assets/bd8/bd8-1440-dark-hover.png) | [editor](../plans/assets/bd8/bd8-1440-dark-editor.png) | [reviews](../plans/assets/bd8/bd8-1440-dark-reviews.png) |

Touch X: [360 light](../plans/assets/bd8/bd8-360-light-touch.png),
[360 dark](../plans/assets/bd8/bd8-360-dark-touch.png).

Regenerate persistent evidence with:

```powershell
$env:PANDA_E2E_BINARY = (Resolve-Path .\pandalibrary.exe).Path
$env:PANDA_BD8_SCREENSHOTS = (Join-Path (Get-Location) 'docs\plans\assets\bd8')
pnpm --dir web exec playwright test src/routes/bookdetail-real.e2e.ts
```

Without the screenshot variable, images still attach to Playwright results.
Servers use temporary isolated data and random localhost ports and are
stopped at teardown; the normal server/database is never modified.

#### Full gate

| Check | Result |
|---|---|
| `pnpm --dir web build` (initial embed prerequisite) | Pass |
| `task sqlc:check lint test build` | Pass; sqlc diff, vet, staticcheck and all Go packages |
| `pnpm --dir web check` | Pass; 0 errors, 0 warnings |
| `pnpm --dir web test` | Pass; 58 files, 488 tests |
| `pnpm --dir web build` + `task build` (final embedded SPA) | Pass |
| `PANDA_E2E_BINARY=... pnpm --dir web test:e2e` | Pass; 221 passed, 0 skipped (7.6 minutes), including all 3 `bookdetail-real.e2e.ts` tests |
| Final `bookdetail-real.e2e.ts` rerun with `PANDA_BD8_SCREENSHOTS` | Pass; 3 passed (34 s); all 38 screenshots regenerated from the final binary |
| Documentation links and `git diff --check` | Pass |

No blocking follow-ups. The plan's existing defaults remain: retain the
Resume-row status icon, keep ratings/notes private, do not prefill reviews
from notes, and finish automatically at 99%. No dependencies were added.
Run Paraglide-generating check/unit/build commands sequentially: concurrent
regeneration can transiently remove message declaration files during check.
