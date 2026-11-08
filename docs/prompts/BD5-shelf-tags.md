# BD5: Shelf tags with remove (X) and the Add-to-shelf popover button

- Status: Done
- Wave: 1. Dependencies merged: baseline (`d6014b0`)
- Can run in parallel with: BD1, BD2, BD3, BD4, BD6
- Branch/worktree: `task/bd5` in `..\pandalibrary-bd5`
- Migration: no

## Read first

- [Book Detail plan](../plans/book-detail-plan.md): R1, R2, decisions 5-6, and
  the "Shelf membership" contract (implement it exactly).
- `web/src/lib/catalog/api.ts` `getBookShelves(bookId, signal)` (viewer-visible
  manual shelves including Favorites), `web/src/lib/shelves/api.ts`
  (`removeBookFromShelf`, `getSessionViewer`), `shelves/form.ts`
  (`offersShelfManagement`, `shelfErrorKey`), `paging/translate.ts`, and
  `shelves/types.ts` (`Shelf.mode`, `system_key`).
- `web/src/lib/bookview/quickview/ShelfPopover.svelte` (trigger, panel,
  keyboard model, the `pandalibrary-shelves-changed` event) and
  `QuickViewContent.svelte` (`shelfName`/`shelfHref` for Favorites, the
  collection chips style).
- `web/src/lib/shelves/AddToShelf.svelte` (the bottom section being replaced;
  BD7 removes it from the page).
- The shelf page's removal confirm: `routes/shelves/[id]/+page.svelte`
  (`window.confirm`).

## Goal

Reusable pieces for the Details tab: a membership store, shelf tags with an
X at the top-right corner that removes the book after confirmation, and an
"Add to shelf" text button that opens the existing shelf popover downward.
BD7 places them on the page.

## Scope

**Owns:** `bookview/details/book-shelves.svelte.ts` (+ test, new),
`bookview/details/BookShelfTags.svelte` (new),
`bookview/quickview/ShelfPopover.svelte` (`variant`/`placement` props only;
the default rendering stays the same), a new section appended to
`bookview/kit-fixture.svelte`, an optional new
`bookview/details/shelves.e2e.ts`, and `bd5.*` messages.

**Must not touch:** `DetailsTab.svelte` (BD7), `QuickViewContent.svelte`,
`AddToShelf.svelte`, and the shelf pages and API.

## Subtasks

### BD5.1 – Membership store

> `createBookShelves(getBookId)` (Svelte 5 runes class or closure):
> - It loads `getBookShelves` and `getSessionViewer` (once per store) with
>   an `AbortController` per book.
> - It suppresses stale responses when the book changes.
> - `status` is `loading | ready | error`.
> - `items` is sorted with Favorites first, then by name (locale compare).
> - `memberIds` is derived from `items`.
> - `canRemove(shelf)` = `offersShelfManagement(shelf, viewer) &&
>   shelf.mode !== 'automatic' && shelf.system_key !== 'unshelved'`.
> - `remove(shelf)` calls `removeBookFromShelf`, drops the item
>   optimistically, restores it on error and throws a translated error. On
>   success it dispatches `pandalibrary-shelves-changed`.
> - `reload()` reloads, and the store also reloads on
>   `pandalibrary-shelves-changed` from elsewhere (for example the popover).
>   Ignore the event its own `remove` dispatched, to avoid a double fetch.
>
> Vitest with mocked APIs: ordering, permissions (admin, private owner,
> another user's private shelf, shared shelf for a non-admin, automatic
> shelf), optimistic removal and rollback, abort on book change, and
> event-driven reload.

### BD5.2 – Tags

> `BookShelfTags.svelte` `{ shelves, bookTitle }`:
> - A small label "Shelves" (`bd5.shelves`, uppercase xs like other card
>   headings), then a wrapping `<ul>` of chips.
> - Each chip is `relative inline-flex max-w-full rounded-full bg-slate-100
>   px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200` and
>   links to the shelf (Favorites → localized name and
>   `/shelves/system/favorites`; others → `/shelves/{id}`). The name
>   truncates.
> - When `canRemove`, add an X button positioned at the chip's **top-right
>   corner** (`absolute -top-1.5 -right-1.5 size-4 rounded-full bg-white
>   text-slate-600 shadow ring-1 ring-black/10 hover:text-red-700`,
>   `Icon name="x"` at `size-3`). It is visible on chip
>   hover/focus-within and always when `(hover: none)`. Its accessible name
>   is `bd5.remove_from` ("Remove from {shelf}").
> - Clicking X asks
>   `window.confirm(m['bd5.remove_confirm']({ title, shelf }))` ("Remove
>   “{title}” from “{shelf}”?"), then calls `shelves.remove(shelf)`. Focus
>   moves to the next chip, or to the label when none is left. Show a
>   `role="status"` notice "Removed from {shelf}" and a `role="alert"` on
>   error.
> - States: loading shows a muted line; error shows a message with Retry
>   (`reload`); with no shelves, show the label and the muted text "Not on
>   any shelf" (`bd5.none`).
> - Offline: render read-only chips with no X (prop `offline?: boolean`).
>
> en + zh copy.

### BD5.3 – Popover button

> `ShelfPopover` gets `variant?: 'icon' | 'button'` (default `icon`, which
> renders exactly as now) and `placement?: 'up' | 'down'` (default `up`).
> `button` renders the same trigger look as the Details tab's Download
> button (`inline-flex items-center gap-1 rounded-lg border border-slate-300
> px-3 py-2 text-sm font-medium hover:bg-slate-100`, `Icon
> name="folder-plus"` + text "Add to shelf" `shelves.book.add`).
> `placement="down"` opens the panel `top-full mt-2 left-0`, clamped to the
> viewport. Members still show ✓ and are disabled. After a successful add,
> it already dispatches `pandalibrary-shelves-changed`, which the store
> picks up.

### BD5.4 – UI verification

> There is no component-test library, and the tab is wired only in BD7. So:
> - Append a "Shelf tags" section to `bookview/kit-fixture.svelte` (fake
>   store data: a private shelf you own, Favorites, and a shared shelf with
>   no remove rights). It is built by the helper in `covers.e2e.ts`
>   (`lib: { entry: … kit-fixture.ts }`). If that helper can be imported or
>   copied without editing `covers.e2e.ts`, add a new
>   `bookview/details/shelves.e2e.ts` that uses it. Otherwise verify the
>   section manually with screenshots.
> - Cover these cases (by e2e when possible, otherwise list them in the
>   hand-off so BD7 tests them on the real tab):
>   - the button popover opens downward, and adding makes the tag appear;
>   - X → Cancel keeps the tag; X → OK removes it with one DELETE call;
>   - there is no X for a shared shelf when the viewer is not an admin;
>   - keyboard: Tab reaches the X, and Enter triggers the confirm;
>   - touch emulation shows the X without hover;
>   - a server error restores the tag and shows an alert.

## Acceptance criteria

- [x] The plan's "Shelf membership" contract is implemented as written.
- [x] R2: tags with a corner X, removal only after confirmation, and
      permissions respected.
- [x] The quick view `ShelfPopover` is unchanged by default (the quick view
      e2e still passes).
- [x] Targeted tests pass.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview/details
pnpm --dir web exec playwright test src/lib/bookview/quickview/quickview.e2e.ts src/lib/bookview/covers.e2e.ts
# plus src/lib/bookview/details/shelves.e2e.ts if you created it
```

## Hand-off

- `createBookShelves(getBookId: () => number | null)` returns reactive
  `items`, `status`, translated `error`, derived `memberIds`, `canRemove`,
  async `remove`, and `reload(): void`. Call the factory during component
  initialization; its effects manage book changes, abort/cleanup, and the
  shelf-change listener. Successful viewer loads are cached for the store;
  failed viewer loads can be retried. Optimistic removals roll back in sorted
  order, ignore stale book responses, and ignore their own change event.
- BD7 should pass this store to `BookShelfTags` with `bookTitle` and
  `offline`, and share `memberIds` with
  `<ShelfPopover variant="button" placement="down">`. The icon/up defaults
  are unchanged. The downward panel clamps horizontally and limits its
  scrollable height to the viewport.
- `shelves.e2e.ts` copies the existing in-memory Vite fixture build without
  changing `covers.e2e.ts`. Its mocked APIs supply an owned private shelf,
  Favorites, an unmanageable shared shelf, and an addable shelf. The fixture
  uses the actual store, not a second implementation of its mutations.
  Nine browser cases cover all BD5.4 hand-off cases, error/retry, empty-state
  focus, offline read-only tags, book changes, viewport bounds, and Chinese
  confirmation/notices. Move these assertions to the real Details tab in
  BD7; `DetailsTab.svelte` and the old bottom shelf form remain untouched.
- Verified: Svelte check with zero errors/warnings; 21 targeted Details unit
  tests (13 membership tests); production build; all 38 targeted browser
  tests across shelf tags, quick view, and covers. Browser/build validation
  used an isolated frontend snapshot, existing dependencies, and a
  task-owned preview to avoid concurrent generated-file/build races in the
  shared checkout. No new dependencies or application test routes.
