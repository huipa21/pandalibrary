# BC6: Dashboard rows — remove Resume button, standard tile width

- Status: Ready
- Wave: 3. Dependencies merged: BC4 (and therefore BC1-BC3)
- Can run in parallel with: BC7
- Branch/worktree: `task/bc6` / `..\pandalibrary-bc6`
- Migration: no

## Read first

- [Book Cover plan](../plans/book-cover-plan.md): requirements R2, R3, R7.
- BC3 and BC4 hand-offs.
- `web/src/lib/dashboard/DashboardRow.svelte` (row `<ul class="flex gap-4
  [&>li]:w-36 sm:[&>li]:w-40">` ~line 186, the `continue_reading` `actions`
  snippet with the Resume button and its error block, `resume()`,
  `resumeBusy`, `resumeError`), `dashboard.e2e.ts`, `dashboard-real.e2e.ts`,
  `web/src/lib/bookview/read.ts` (Play already resumes through `resumeFile`).
- Pasted Image 2.

## Goal

Dashboard rows show only cover tiles at the standard size. Hovering Play
resumes or starts the book, and nothing is drawn under the covers.

## Scope

**Owns:** `DashboardRow.svelte`, `dashboard*.e2e.ts`, and removal of now
unused `ux5.resume*` / `ux5.choose_format` message keys (only if no other
file uses them; check with `rg`).

**Must not touch:** `dashboard/resume.ts` (still used by `read.ts`),
`CoverActions`, `BookCard`.

## Subtasks

### BC6.1 – Remove Resume

> Delete the `actions` snippet, `resume()`, `resumeBusy`, `resumeError`
> and the `goto`/`resumeFile` imports that become unused. The resume-file
> missing case is now handled by Play: `readTarget` falls back to the first
> readable format, and Play's own error shows under the tile.

### BC6.2 – Row sizing

> Row: `<ul class="flex gap-5 pt-1 pb-3 [&>li]:w-36 [&>li]:shrink-0
> sm:[&>li]:w-book">`. The extra top/bottom padding is so the 4 px lift and
> shadow are not clipped by `overflow-x-auto`. Keep the scroll buttons. The
> scroll step stays 80% of the client width.

### BC6.3 – Tests

> Update `dashboard.e2e.ts`: there is no "Resume reading" button; hovering a
> continue-reading tile and clicking Play navigates to the saved file; a
> missing saved file opens the first readable format; tile width =
> `--spacing-book` at 1440; the lift is not clipped (the tile's bounding box
> top ≥ the scroller's top). Update `dashboard-real.e2e.ts` selectors that
> used the Resume button.

## Acceptance criteria

- [ ] R2 and R3 on the dashboard; R7 width.
- [ ] No unused imports or messages remain.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/dashboard
pnpm --dir web exec playwright test src/lib/dashboard/dashboard.e2e.ts
```

## Hand-off

Set this prompt to Done and update the BC6 row/log.
