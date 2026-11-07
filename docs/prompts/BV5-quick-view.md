# BV5: Quick view drawer

- Status: Ready
- Wave: 2. Dependencies merged: BV1, BV3 (BV2 and BV4 are merged too but not needed)
- Can run in parallel with: BV6, BV7, BV8, BV9
- Branch/worktree: `task/bv5` / `..\pandalibrary-bv5`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md): decisions 4, 5 and 9, the
  events contract, the UI kit, `GET /api/v1/books/{id}/shelves`.
- The BV1 and BV3 hand-off log entries in
  [progress/README.md](../progress/README.md) (final kit props).
- `web/src/lib/bookview/**` (BV3 kit), `web/src/lib/shell/AppShell.svelte`,
  `web/src/lib/shelves/AddToShelf.svelte` and `api.ts`,
  `web/src/lib/shelves/ShelfCreateDialog.svelte` (focus trap/restore pattern),
  `web/src/lib/shell/focus.ts`, `web/src/lib/reader/api.ts` (`getBookState`),
  `web/src/lib/catalog/api.ts` (`getBook`).
- Screenshot 4. Its layout, top to bottom: close X; cover thumbnail beside the
  title, provider link icons, author and stars `3/5`; a divider; chips (format
  with a dot, pages, published date, LANGUAGE); publisher; a "Primary file"
  card (name, format chip, size); tag chips; "Collections" with shelf chips;
  the synopsis with "Show more"; and a sticky footer with Read, Details, eye
  and folder-plus.

## Goal

Clicking Info on any cover opens a right-side drawer with a quick view of the
book in the app's own style. From it the user can read, open the details page,
change the reading status or add the book to a shelf, without leaving the
list.

## Scope

**Owns:** `web/src/lib/bookview/quickview/QuickViewHost.svelte`,
`QuickViewDrawer.svelte`, `QuickViewContent.svelte`, `quick-view-data.ts` (+ tests),
`ShelfPopover.svelte`, `web/src/lib/bookview/quickview/quickview.e2e.ts`, and
`bv5.*` messages. Use BV1's `getBookShelves` from `web/src/lib/catalog/api.ts`.

**Shared (one-line edit):** render `<QuickViewHost />` once in `AppShell.svelte`
for authenticated, non-immersive routes.

**Must not touch:** the BV3 kit internals (report needed changes in the
hand-off instead), tab files, backend.

## Subtasks

### BV5.1 – Data loader

> Create `quick-view-data.ts`: `loadQuickView(bookId, seed?: Book, signal)`
> fetches `getBook` (it skips the fetch when `seed` is complete), `getBookState`
> and `getBookShelves` in parallel. Missing per-user state (offline or error)
> degrades to `null` without failing the drawer. A 403/404 on the book is a
> not-found state. It returns `{ book, userBook, progress, shelves, primaryFile }`,
> where `primaryFile` is the progress file when it still exists, else the
> preferred-format file. Offline (`offlineAvailable()` and no network), it
> loads the book via `loadOfflineBook` and skips the shelves. Unit-test the
> merging, degradation, primary file choice and abort.

### BV5.2 – Drawer host and shell

> Create `QuickViewHost.svelte`, which listens for `QUICK_VIEW_EVENT` and opens
> `QuickViewDrawer` for `detail.bookId` (a new event while open replaces the
> book). Create `QuickViewDrawer.svelte`: a fixed right panel (`w-full
> sm:w-[28rem]`, full height, white, left border, `shadow-2xl`) over a
> `bg-slate-900/40` backdrop. It slides in from the right (200 ms, none with
> `prefers-reduced-motion`) and uses `role="dialog"`, `aria-modal="true"` and
> `aria-labelledby` = the title. It traps focus, focuses the close button
> on open, and closes on Escape, X, a backdrop click and `afterNavigate`. It
> restores focus to `detail.trigger`. It locks body scroll while open. The
> body scrolls, and the footer is sticky. It reloads on `BOOK_STATE_CHANGED_EVENT`
> and `pandalibrary-shelves-changed` for the shown book. It shows loading,
> not-found and error-with-retry states.

### BV5.3 – Content (adapt screenshot 4 to the app style)

> Create `QuickViewContent.svelte`. Header: `BookCover size="sm"` (w-24, with
> badge), the title (`text-lg font-semibold`, links to `/books/{id}`),
> `IdentifierLinks variant="icons"`, the authors (links to `/authors/{id}`) and
> `RatingStars` read-only. If there is no rating, show nothing. Then a divider.
> Chips row (`rounded-md bg-slate-100 text-xs`): the format chip with a
> colored dot (`FormatBadge` tone), `N pages`, the published date
> (`formatDate`) and the language (uppercase, from `Intl.DisplayNames` when
> possible). Publisher as muted text. Series as a link with its index. A
> **Primary file** card (`rounded-xl border bg-slate-50`): the small caps label,
> `original_filename`, the format chip and size, and `x% read` when progress
> points at it. Tag chips (`bg-emerald-50 text-emerald-800`, links to
> `/tags/{id}`). **Collections**: shelf chips with a folder icon, linking to
> `/shelves/{id}`, Favorites first. Hidden when empty. Then a divider and the
> synopsis via `ExpandableText lines={5}`.
> Footer (`border-t bg-white p-4`, grid): **Read / Resume** (emerald, primary,
> `read.ts`; "Resume" when progress > 0; disabled with a tooltip when nothing is
> readable), **Details** (outline emerald, goes to `/books/{id}` and closes),
> `ReadStatusMenu variant="icon"` (eye icon, accessible name "Reading
> status"), and an **Add to shelf** icon button opening `ShelfPopover`.
> `ShelfPopover` reuses the logic of `AddToShelf.svelte` (same filters and
> error keys). Extract the shared logic into a function in
> `web/src/lib/shelves/` only if needed, without changing `AddToShelf`
> behavior. Admins also get a small "Edit metadata" link in the header menu. It
> is hidden offline.

### BV5.4 – Tests

> Add `quickview.e2e.ts` (mocked API): Info on an All Books card opens the
> drawer with the title, chips, primary file, tags, collections and synopsis;
> Show more expands; Escape and the backdrop close it and focus returns to the
> Info button; Tab stays inside; Details navigates to `/books/{id}` and the
> drawer closes; Read opens the reader URL; changing the status pushes one
> `user_books` mutation and updates the menu label; Add to shelf calls
> `PUT /shelves/{id}/books/{bookId}` and the new chip appears; a 404 book shows
> the not-found state; at 390 px the drawer is full width; no horizontal scroll.

## Out of scope

Editing rating or dates (the Details tab), and highlights/notes content.

## Acceptance criteria

- [ ] The drawer opens from every Info button (grid, list, dashboard, shelves,
      search) and matches the described structure in the app palette.
- [ ] Accessibility: dialog semantics, focus trap/restore, Escape, labelled icon
      buttons, reduced motion.
- [ ] Stale responses never overwrite a newer book (open A, then B quickly).

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/quickview/quickview.e2e.ts src/lib/shell/shell.e2e.ts
```

## Hand-off

Set this prompt to Done and update the BV5 row/log.
