# BC5: Bookheap grid view and unified heap covers

- Status: Done
- Wave: 2. Dependencies merged: BC3
- Can run in parallel with: BC4
- Branch/worktree: `task/bc5` / `..\pandalibrary-bc5`
- Migration: no

## Read first

- [Book Cover plan](../plans/book-cover-plan.md): decisions 3, 4 and 8.
- BC3 hand-off (`--spacing-book`, `.book-grid`, `BookCover` props incl.
  `size="xs"`).
- `web/src/lib/bookheap/BookheapPage.svelte` (list `<ul class="space-y-2">`
  ~line 269, selection state, filters), `HeapItemRow.svelte` (48x64
  thumbnail and placeholder, `heapThumbnailUrl`), `api.ts`, `types.ts`
  (`HeapItem`: `id`, `title`, `authors: string[]`, `has_cover`, `cover_url`,
  `status`, `file_name`, `rel_path`), `bookheap.e2e.ts`, `test-fixtures.ts`.

## Goal

Bookheap covers use the same artwork and, in grid view, the same size as
every other section.

## Scope

**Owns:** `web/src/lib/bookheap/**` (including a new `HeapItemTile.svelte`)
and `bc5.*` messages.

**Must not touch:** `bookview/**` (import `BookCover` only), catalog pages.

## Subtasks

### BC5.1 – List thumbnails

> In `HeapItemRow`, replace the thumbnail box and placeholder with
> `<BookCover size="xs" id={item.id} title={item.title}
> authors={item.authors} coverUrl={heapThumbnailUrl(item)} class="w-12" />`.
> Keep `data-testid="bh4-cover-placeholder"` on the generated fallback
> wrapper so existing tests keep their meaning, or update them.

### BC5.2 – Grid view

> Add a Grid/List segmented toggle next to the existing filters
> (`aria-pressed`), persisted in `localStorage`
> (`pandalibrary.bookheap.view`), default **grid**. Grid = `<ul
> class="book-grid">` of `HeapItemTile`: a `BookCover` (`w-full`, standard
> artwork), a selection checkbox `absolute top-2 left-2` (white chip, the
> same `ontoggle` and accessible label as the row), a heap status chip
> `absolute top-2 right-2` (the existing status label/tone from the row), and
> below the cover the title (`line-clamp-2 text-sm font-medium`) and file name
> (`text-xs text-slate-500 truncate`, `title=rel_path`). Heap items have no
> details page, reading status or progress. The text is kept because this is
> an admin triage view. Hover gives the same lift as BC4 (copy the 4 px
> translate + shadow, honouring reduced motion). Selection, bulk actions,
> paging and empty/error states work identically in both views.

### BC5.3 – Tests

> Extend `bookheap.e2e.ts`: the default is grid; the toggle persists across
> reload; selecting in grid then switching to list keeps the selection; an
> item without a cover renders `[data-generated-cover]`; the tile width
> equals `--spacing-book` at 1440 px.

## Out of scope

Catalog tiles (BC4/BC7); heap item assign/edit behaviour.

## Acceptance criteria

- [x] Grid tile cover width = `--spacing-book` at `sm+`; the artwork matches
      catalog covers.
- [x] Bulk select/assign/delete still work in both views.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookheap
pnpm --dir web exec playwright test src/lib/bookheap/bookheap.e2e.ts src/lib/bookheap/upload.e2e.ts
```

## Hand-off

Set this prompt to Done and update the BC5 row/log.

Implemented in the current `master` worktree (uncommitted):

- Default grid and saved Grid/List preference (`pandalibrary.bookheap.view`);
  switching does not reload pages or clear selection. Storage failures are
  logged and shown with localized messages.
- `HeapItemTile` uses the shared `BookCover`, selection and heap-status chips,
  title/file-name text, and reduced-motion-aware hover/focus lift. Error text
  and duplicate links remain available for triage.
- List thumbnails use `BookCover size="xs"` at 48 px; generated-cover tests
  use `[data-generated-cover]` instead of the old file-icon placeholder.
  Both views keep `data-testid="bh4-row"` and existing status/error hooks;
  grid tiles additionally expose `[data-heap-tile]`.
- Shared heap status labels/tones live in `bookheap/status.ts`. BC8 can
  consolidate the lift CSS with BC4 without changing heap selection.
- Svelte check: zero errors/warnings. Bookheap Vitest: 46 tests passed.
  Production build and 16 Bookheap/upload browser tests passed. Browser
  checks verify 208 px cover width at 1440 px, 2:3 geometry, mobile columns
  without overflow, image fallback, persistence, selection, bulk actions,
  and retry/storage failures. The final browser run used an isolated static
  build snapshot because concurrent builds replaced shared preview assets.
