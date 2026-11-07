# BV4: Book details shell – route group, tab bar, book context, browse prev/next

- Status: Ready
- Wave: 1. Dependencies merged: baseline `72c469c`
- Can run in parallel with: BV1, BV2, BV3
- Branch/worktree: `task/bv4` / `..\pandalibrary-bv4`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md): decisions 6, 7 and 8, the
  book context, browse context and tab slot contracts, ownership.
- `web/src/routes/books/[id]/+page.svelte` (all current behavior: online and
  offline loading, cover object URLs, admin edit link, offline download/remove,
  Add to shelf, identifiers, provenance), `web/src/routes/books/[id]/edit/`,
  `web/src/lib/catalog/BookBrowser.svelte`, `web/src/routes/shelves/[id]/+page.svelte`,
  `web/src/routes/shelves/system/[key]/+page.svelte`, `web/src/lib/shell/AppShell.svelte`
  (content width), `web/src/routes/catalog.e2e.ts`, `web/src/lib/sync/offline.e2e.ts`.
- Screenshots 5-8: a sticky tab bar with "‹ Books | Details Files Reading Log
  Highlights" on the left and "2 / 56250 ‹ ›" on the right; the active tab has an
  emerald underline.

## Goal

`/books/{id}` becomes a tabbed area with Details, Files, Reading Log and
Highlights. The book is loaded once by a shared layout (online or offline) and
shared through context. The tab bar offers back navigation and previous/next
through the list the user came from. Today's page content keeps working
unchanged inside the Details tab until BV6/BV7 replace it.

## Scope

**Owns:** `web/src/routes/books/[id]/(tabs)/+layout.svelte`, `(tabs)/+page.svelte`,
`(tabs)/files/+page.svelte`, `(tabs)/reading-log/+page.svelte`,
`(tabs)/highlights/+page.svelte`; deleting `web/src/routes/books/[id]/+page.svelte`;
`web/src/lib/bookview/book-context.svelte.ts`, `browse-context.ts` (+ tests);
`web/src/lib/bookview/BookTabs.svelte`; the placeholder
`web/src/lib/bookview/tabs/{DetailsTab,FilesTab,ReadingLogTab,HighlightsTab}.svelte`;
`web/src/lib/bookview/details-shell.e2e.ts`; `bv4.*` messages.

**Shared (one-line edits):** call `rememberBrowseContext` in `BookBrowser.svelte`,
`routes/shelves/[id]/+page.svelte` and `routes/shelves/system/[key]/+page.svelte`
whenever their loaded item list changes.

**Must not touch:** `BookCard.svelte` / `SearchResultCard.svelte` (BV3),
`routes/books/[id]/edit/**`, `AppShell.svelte`, backend.

## Subtasks

### BV4.1 – Book context

> Create `book-context.svelte.ts`: a class or factory holding `$state` for
> `book`, `offline`, `coverSource`, `coverError`, `canEditMetadata`, `loading`
> and `error`, plus `load(id)` / `reload()`. Move the loading logic from the
> current `routes/books/[id]/+page.svelte` without changing behavior: ID
> validation, online `getBook` vs. offline `loadOfflineBook`, admin detection
> via `getSessionViewer`, cover object URLs via `loadCover` with revoke on
> change/destroy, request-version stale suppression, and the same error
> mapping. Export `setBookContext(ctx)` / `getBookContext()` using Svelte
> `setContext`/`getContext` with a private symbol key. Reload when the window
> event `'pandalibrary-book-state-changed'` fires with `detail.bookId` equal
> to this book, and when `pandalibrary-shelves-changed` fires. BV3 runs in
> parallel and owns the constant in `events.ts`, so use a local
> `const BOOK_STATE_CHANGED = 'pandalibrary-book-state-changed'` marked
> `// BV10: import from events.ts`.

### BV4.2 – Browse context

> Create `browse-context.ts`: `rememberBrowseContext({ ids, label, href })`
> stores at most 5,000 unique positive IDs plus the label and the origin href
> in `sessionStorage` (key `pandalibrary.browse-context`; ignore quota and
> privacy-mode errors). `browseNeighbors(bookId)` returns `{ index (1-based),
> total, previousId, nextId, label, href }` or `null` when the book is not in
> the stored list. Unit-test the bounds, duplicates, a missing book, corrupt
> storage and the size cap. Wire the one-line calls in `BookBrowser` (label =
> the page heading or a filter description, href = current URL), the shelf
> page and the system shelf page.

### BV4.3 – Layout, tab bar and routes

> Create the `(tabs)` route group. `+layout.svelte` creates the book context
> from `page.params.id`, renders loading/error states (same copy and retry
> links as today), and renders `BookTabs` above `{@render children()}` when
> loaded. `BookTabs.svelte` is a sticky top bar (white, bottom border,
> `rounded-t-2xl` to match dashboard cards). On the left: **‹ Books** (uses
> `history.back()` when `document.referrer`/navigation state shows an in-app
> previous entry, else `/books` or the browse-context `href`), a divider, then
> links Details, Files, Reading Log and Highlights with `aria-current="page"`
> and an emerald 2 px underline on the active tab. It scrolls horizontally on
> narrow screens. On the right, when `browseNeighbors` is not null: `i / n` and
> two icon buttons (Previous/Next book, accessible names, disabled at the
> ends) that navigate to the same tab of the neighbor, plus the keyboard
> shortcuts `[`/`]` when focus is not in a text field. Every tab route renders
> its placeholder from `web/src/lib/bookview/tabs/`. The `(tabs)/+page.svelte`
> renders `DetailsTab`, which initially contains today's full page body (header,
> cover, details, tags, files, Add to shelf, identifiers, provenance) moved
> verbatim but reading from `getBookContext()`. The Files, Reading Log and
> Highlights placeholders show a short localized "Coming soon" panel. Delete
> the old `routes/books/[id]/+page.svelte`. Confirm `/books/{id}/edit` still
> renders without the tab bar. Set the document `<title>` to
> `{book title} · {tab}`.

### BV4.4 – Tests

> Add `details-shell.e2e.ts` (mocked API): the four tabs navigate and set
> `aria-current`; Back works; prev/next appear after visiting from All Books,
> step through the list (`i / n` updates), and are hidden on a direct visit;
> the edit page has no tab bar; an invalid ID shows the error state. Run the
> existing `catalog.e2e.ts`, `offline.e2e.ts` and
> `routes/books/[id]/edit/metadata.e2e.ts` and fix any selector that changed
> only because of the move (do not weaken assertions).

## Out of scope

Redesigning Details (BV6) and the content of Files/Reading Log/Highlights
(BV7-BV9).

## Acceptance criteria

- [ ] All four tab URLs work. Details shows today's content unchanged in
      behavior, including offline.
- [ ] The book is fetched once per book ID across tab switches (assert via the
      request count in e2e).
- [ ] Prev/next and Back behave as specified. The edit route is unaffected.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/details-shell.e2e.ts src/routes/catalog.e2e.ts src/lib/sync/offline.e2e.ts "src/routes/books/[id]/edit/metadata.e2e.ts"
```

## Hand-off

Set this prompt to Done and update the BV4 row/log. Record the exact
`getBookContext()` shape in the log for BV6-BV9.
