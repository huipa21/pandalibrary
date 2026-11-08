# BD8: Integration, real-server E2E, visual QA, docs, full gate

- Status: Ready
- Wave: 3 (alone). Dependencies merged: BD1-BD7
- Can run in parallel with: none
- Branch/worktree: `task/bd8` in `..\pandalibrary-bd8` (or `master`)
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
> Only the legacy redirect route may match.

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

- [ ] R1-R13 verified on a real server, with screenshots attached.
- [ ] No unused message keys or dead components remain.
- [ ] Docs updated.
- [ ] Full gate green.

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
