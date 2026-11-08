# BD1: Back icon with origin return, previous/next fix, Activities tab

- Status: Done
- Wave: 1. Dependencies merged: baseline (`d6014b0`)
- Can run in parallel with: BD2, BD3, BD4, BD5, BD6
- Branch/worktree: `task/bd1` in `..\pandalibrary-bd1`
- Migration: no

## Read first

- [Book Detail plan](../plans/book-detail-plan.md): R4, R13, decisions 1-4,
  the "Origin store" and "Tabs" contracts, and the R4 root cause in the
  assessment.
- `web/src/routes/books/[id]/(tabs)/+layout.svelte` (`backUsesHistory`,
  `afterNavigate`, `inBookArea`), `web/src/lib/bookview/BookTabs.svelte`,
  `web/src/lib/bookview/browse-context.ts` (+ test).
- Callers of `rememberBrowseContext`: `catalog/BookBrowser.svelte`,
  `routes/shelves/[id]/+page.svelte`, `routes/shelves/system/[key]/+page.svelte`.
  The Dashboard (`dashboard/DashboardRow.svelte`) does not call it yet.
- The child flows that push `/books/{id}`: `routes/read/[bookId]/[fileId]/+page.svelte`
  (`closeReader`, the Back link) and `routes/books/[id]/edit/+page.svelte`.
- `web/src/lib/bookview/details-shell.e2e.ts` (shell tests), `Icon.svelte`.

## Goal

The header's "‹ Books" becomes a back icon that always returns to the page
the user came from (Dashboard, All Books, a shelf, search, an author…). It
must still work after visiting the reader or the metadata editor. Previous/next
never shows a stale list. The Reading Log tab is renamed Activities.

## Scope

**Owns:** `BookTabs.svelte`, the `(tabs)/+layout.svelte`, the new
`bookview/book-origin.ts` (+ `book-origin.test.ts`), `browse-context.ts`
(+ test), the route folder `(tabs)/reading-log` → `(tabs)/activities` and a
legacy redirect, the `ReadingLogTab.svelte` heading, `DashboardRow.svelte`
(browse context on tile activation only), `Icon.svelte` (append
`arrow-left`), `details-shell.e2e.ts`, and `bd1.*` messages.

**Must not touch:** `DetailsTab.svelte` and `ReadingCard.svelte` (BD7), the
reader and edit pages (they keep pushing `/books/{id}`; the origin logic
handles it), other `bookview/details/*` files.

## Subtasks

### BD1.1 – Origin store

> Create `book-origin.ts` per the plan contract. `isBookArea(pathname)`
> matches `/books/{id}` and its tab subpaths, but **not** `/books/{id}/edit`.
> `isBookChildFlow(pathname)` matches `/read/…` and `/books/{id}/edit`.
> `rememberBookOrigin(href, label?)` stores `{ href, label }` under
> `pandalibrary.book-origin` in `sessionStorage`. It ignores unsafe hrefs
> (reuse or export `safeHref` from `browse-context.ts`), book-area hrefs and
> child-flow hrefs, and swallows storage errors. `readBookOrigin()` validates
> the stored value. Add `originLabel(href)`. It returns the browse-context
> label when the stored context `href` equals `href`, else a route name:
> `/` Dashboard, `/books` All books, `/search` Search, `/bookheap` Bookheap,
> `/bookmarks` Bookmarks, `/notes` Notes, `/shelves/…` Shelf,
> `/authors/…` Author, `/series/…` Series, `/tags/…` Tag, `/library/…`
> Library. Otherwise it returns null. Unit-test every branch.

### BD1.2 – Layout and back icon

> In the layout, drop `backUsesHistory` and handle **every** `afterNavigate`
> (not only the first):
>
> - `from` is outside the book area and not a child flow → call
>   `rememberBookOrigin(from.url.pathname + from.url.search)` and set
>   `directFromOrigin = true`. The previous history entry is the origin.
> - `from` is a child flow (`/read/…`, `/books/{id}/edit`) → keep the stored
>   origin and set `directFromOrigin = false`.
> - `from` is inside the book area: tab and previous/next navigations use
>   `replaceState`, so keep `directFromOrigin` as it is. A pushed navigation
>   (for example a related book) sets it to `false`. `AfterNavigate` has no
>   replace flag, so detect a push by a growing `history.length` and treat
>   `popstate` as "unknown" (`false`).
> - No `from` (full page load) → use a same-origin `document.referrer` with
>   the same filters. Otherwise keep whatever origin is stored and set
>   `directFromOrigin = false`.
>
> Pass `{ origin, directFromOrigin }` to `BookTabs`.
>
> In `BookTabs`, replace the "‹ Books" link with a 36 px round icon link:
> `Icon name="arrow-left"` (add it to `Icon.svelte`: a left arrow, 24×24
> stroke, `Icon.svelte` style). `href = origin?.href ?? '/'`. Its
> `aria-label` and `title` are `bd1.back_to` ("Back to {label}") when
> `originLabel` is known, else `bd1.back` ("Back"). On a plain left click:
> use `history.back()` when `directFromOrigin`, else `goto(href)`. Keep the
> separator, the tab list and the emerald focus ring.

### BD1.3 – Previous/next consistency

> `browseNeighbors(bookId, originHref?)` returns null when `originHref` is
> given and differs from the stored context `href`. `BookTabs` passes the
> origin href. In `DashboardRow.svelte`, record
> `rememberBrowseContext({ ids: row book IDs, label: row title, href: '/' })`
> when a tile link in that row is activated. Use a capture-phase `click`
> and `keydown` (Enter) handler on the row `<ul>`, filtered to anchors whose
> path is `/books/{id}`. Do not record on render, because several rows render
> at once. Extend `browse-context.test.ts`.

### BD1.4 – Activities tab

> Rename the tab key and route: `BookTab` `'reading-log'` → `'activities'`,
> folder `(tabs)/reading-log` → `(tabs)/activities`. Add a legacy
> `(tabs)/reading-log/+page.ts` that throws `redirect(307,
> '/books/{id}/activities' + url.search)`. Check that it works with the SPA
> fallback build; if a `load` redirect is not possible there, use
> `goto(…, { replaceState: true })` in a tiny `+page.svelte`. Map the legacy
> segment in `bookTabFromPath`. Labels: `bd1.tabs.activities` = "Activities"
> / "阅读动态". Use it in `bookTabLabel` and the `ReadingLogTab` sr-only
> heading. Update the links in the e2e specs that you own. BD7/BD8 update
> the others (`ReadingCard` is deleted by BD7; the legacy redirect keeps old
> links working).

### BD1.5 – Tests

> In `details-shell.e2e.ts` (mocked API), cover:
> (a) Dashboard → book → back returns to `/` and restores the scroll
> position;
> (b) shelf → book → **Resume → reader Back** → back icon returns to the
> shelf (the reported bug; it must not reopen the reader);
> (c) All Books (with a query string) → book → Files tab → Activities tab →
> back returns to the same All Books URL;
> (d) book → metadata edit → "Back to book" → back icon returns to the
> original list;
> (e) a related-book link inside the book area keeps the original origin;
> (f) a deep link in a fresh context goes to `/`;
> (g) Dashboard → book shows previous/next for that row only, and a stale
> All Books context is not shown;
> (h) `/books/{id}/reading-log` lands on `/activities` with the tab active;
> (i) the back icon's accessible name ("Back to Dashboard").

## Acceptance criteria

- [x] R4: the back icon returns to the entry page for every entrance listed
      in BD1.5, including after the reader and the editor round trips.
- [x] No visible "Books" text. The icon has an accessible name and a tooltip.
- [x] Previous/next only shows for the list the user came from.
- [x] The tab reads "Activities" (en/zh). The old URL redirects.
- [x] Unit + e2e tests above pass.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview/book-origin.test.ts src/lib/bookview/browse-context.test.ts
pnpm --dir web exec playwright test src/lib/bookview/details-shell.e2e.ts src/lib/bookview/log/log.e2e.ts
```

## Hand-off

Set this prompt to Done, update the BD1 row/log in
[progress/README.md](../progress/README.md), and record the final
`book-origin.ts` API and any legacy-redirect caveat for BD7/BD8.
