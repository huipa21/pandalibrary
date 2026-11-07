# BC8: Integration, real-server E2E, visual QA, docs, full gate

- Status: Ready
- Wave: 4 (alone). Dependencies merged: BC1-BC7
- Can run in parallel with: none
- Branch/worktree: `task/bc8` / `..\pandalibrary-bc8`
- Migration: no (BC1's 00005 must already be merged)

## Read first

- [Book Cover plan](../plans/book-cover-plan.md) (all decisions and
  requirements R1-R7).
- Every BC hand-off in [progress/README.md](../progress/README.md).
- `web/src/routes/bookview-real.e2e.ts` (real-server pattern: pushing
  mutations, seeding books), `docs/architecture/book-view.md`.
- Pasted Images 1-3 (the visual targets).

## Goal

All BC branches are merged and consistent, verified against a real server,
and the full gate is green.

## Subtasks

### BC8.1 – Merge and seams

> Merge `task/bc1`…`task/bc7`. Resolve the expected seams: BC5 copied BC4's
> lift CSS, so extract one shared `.book-tile-lift` class into `layout.css`
> and use it in both; message key unions; any leftover `grid`→`tile`
> variant aliases; dead code from the removed Resume button and `reread`.
> Run `rg -n "aspect-\[3/4\]|w-40\]|grid-cols-4" web/src` and remove any
> leftover non-token cover sizing.

### BC8.2 – Real-server E2E

> Add `web/src/routes/covers-real.e2e.ts`: seed books with and without
> covers; push `user_books` statuses for all 8 values and `reading_progress`
> at 0, 0.42 and 1. Assert on dashboard, All Books, a manual shelf, a system
> shelf and related books: there is no text under tiles; a generated cloth
> cover for coverless books; the badge icon/name per status (unread only on
> hover); `42%` on hover; Play resumes the saved file; changing status via
> the badge persists after reload and moves the book between dashboard
> sections (for example skimmed leaves continue-reading); one
> `/me/book-states` call per page; equal tile widths across all surfaces at
> 1440; the Bookheap grid tile width matches. Also test the migration on a
> copy of a pre-BC database (statuses preserved).

### BC8.3 – Visual QA

> Screenshots at 360, 768 and 1440 px of every surface above, in hover and
> rest states, plus the status menu open from a badge at a row's right edge
> (not clipped). Compare against Images 1-3; fix spacing/contrast issues
> (author gold on ochre/khaki must meet 3:1 for large text, otherwise use the
> dark variant). Check reduced motion and keyboard-only flows.

### BC8.4 – Docs and gate

> Update `docs/architecture/book-view.md` (cover kit, tile chrome, statuses,
> book-states store) and the API docs for `/me/book-states`. Set the plan's
> Status to Done in [book-cover-plan.md](../plans/book-cover-plan.md) and
> [plans/README.md](../plans/README.md). Run the full gate.

## Acceptance criteria

- [ ] R1-R7 verified on a real server with screenshots attached.
- [ ] Full gate green.

## Validation commands (full gate)

```powershell
task sqlc:check lint test build
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:e2e
```

## Hand-off

Set this prompt to Done, update the BC8 row/log, and mark the BC board
complete.
