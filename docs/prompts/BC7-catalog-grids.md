# BC7: All Books, entity pages, shelves and related books — standard grid

- Status: Ready
- Wave: 3. Dependencies merged: BC4 (and therefore BC1-BC3)
- Can run in parallel with: BC6
- Branch/worktree: `task/bc7` / `..\pandalibrary-bc7`
- Migration: no

## Read first

- [Book Cover plan](../plans/book-cover-plan.md): requirement R7 and the
  `.book-grid` token contract.
- BC3 and BC4 hand-offs.
- `web/src/lib/catalog/BookBrowser.svelte` (~line 262, `grid grid-cols-2
  gap-4 sm:grid-cols-3 lg:grid-cols-4`; used by All Books and the
  library/author/series/tag pages via `EntityDetail`),
  `web/src/routes/shelves/[id]/+page.svelte` (~line 288 grid plus the
  `actions` snippet with the remove-from-shelf control),
  `web/src/routes/shelves/system/[key]/+page.svelte` (~line 85,
  `sm:grid-cols-2 lg:grid-cols-3`),
  `web/src/lib/bookview/details/RelatedBooks.svelte` (~line 38 carousel
  `[&>li]:w-36`), and the E2E specs that cover them (`routes/catalog.e2e.ts`,
  `routes/search-shelves.e2e.ts`, `bookview/details/details.e2e.ts`).

## Goal

Every catalog grid and carousel uses the same tile size as the dashboard.

## Scope

**Owns:** the four files above (grid/carousel classes only, plus the shelf
`actions` snippet styling) and their E2E selector updates.

**Must not touch:** `BookCard`, `CoverActions`, list mode layouts.

## Subtasks

### BC7.1 – Grids

> Grid mode in `BookBrowser`, the manual shelf page and the system shelf
> page: `<ul class="book-grid">`. List mode is unchanged. Make sure the shelf
> page's remove-from-shelf `actions` snippet still renders under the tile
> (compact: an icon+text button, `text-xs`, full tile width). If it looks
> cramped, move it to a top-right tile menu in a follow-up note rather than
> touching `BookCard`.

### BC7.2 – Related books carousel

> `RelatedBooks` carousel: `flex gap-5 pt-1 pb-3 [&>li]:w-36
> sm:[&>li]:w-book [&>li]:shrink-0`, so the lift is not clipped.

### BC7.3 – Tests

> Update selectors that relied on the title text under grid covers
> (use `getByRole('link', { name: … })`, `aria-describedby` or
> `[data-book-id]`). Add one assertion per surface: the tile width equals
> `--spacing-book` at 1440 (All Books, a manual shelf, a system shelf,
> related books), and the 2-column fluid grid at 360.

## Acceptance criteria

- [ ] At 1440 px the dashboard, All Books, author/series/tag/library pages,
      manual and system shelves, related books and the Bookheap grid tiles
      have the same cover width.
- [ ] No horizontal overflow at 360 px.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec playwright test src/routes/catalog.e2e.ts src/routes/search-shelves.e2e.ts src/lib/bookview/details/details.e2e.ts
```

## Hand-off

Set this prompt to Done and update the BC7 row/log.
