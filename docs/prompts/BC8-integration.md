# BC8: Integration, real-server E2E, visual QA, docs, full gate

- Status: Blocked only on direct comparison with the unavailable original reference images
- Wave: 4 (alone). Dependencies merged: BC1-BC7
- Can run in parallel with: none
- Branch/worktree: `master` / current worktree (uncommitted)
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

- [x] R1-R7 verified against the written plan on a real server with screenshots attached.
- [x] Full gate green.
- [ ] Compare the captures with the original Images 1-3; those images are not
      available in this session or repository.

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

The first web build supplies the Go embed; the second `task build` embeds the
final SPA before the real-server browser run. Without `PANDA_E2E_BINARY`,
Playwright skips the real-server specs.

## Hand-off

| Gate | Result |
|---|---|
| `task sqlc:check lint test build` | Pass: sqlc diff, Go vet, staticcheck, all Go tests and CGO-free build |
| `pnpm --dir web check` | Pass: 0 errors, 0 warnings |
| `pnpm --dir web test` | Pass: 51 files, 382 tests |
| `pnpm --dir web build` and `task build` | Pass; final SPA embedded in the binary |
| Real-server `pnpm --dir web test:e2e` | Pass: 180 tests, including 6 cover integration tests |
| Visual and accessibility QA | 40 screenshots: six surfaces at 360/768/1440 px in rest and hover states, three edge menus, and one touch view; keyboard, reduced motion and rendered contrast checked against the written plan; all eight palettes also passed a targeted contrast rerun |
| Original reference images | Blocked: Images 1-3 were unavailable, so no direct image-to-image comparison is claimed |

BC1-BC7 were already integrated in `master`; no branch merges were required.
See the BC8 progress entry for the integration fixes and remaining follow-up.
