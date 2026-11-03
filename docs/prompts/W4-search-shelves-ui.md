# W4: Search and shelves UI

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § W4
- Depends on (merged): S1, SH1, W1
- Can run in parallel with: ST1, E1, O1
- Branch / worktree: `task/w4` in `..\pandalibrary-w4`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§5, 12, 15
- [architecture/database.md](../architecture/database.md) §§1–5, 8–10
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- [S1 search API and result contract](./S1-search.md),
  [SH1 shelf API and permission contract](./SH1-shelves.md),
  [W1 catalog UI](./W1-library-ui.md), and the merged
  `web/src/lib/api/`, `web/src/lib/catalog/`, route, navigation, and localization patterns

## Goal

Add a bilingual, accessible search experience and shelf management/browsing UI using only
the merged S1 and SH1 APIs. Search results and shelf pages reuse W1's catalog presentation
and honor server-side visibility, pagination, ownership, and permission behavior.

## Scope

**Owns (create/modify freely):**
- `web/src/routes/search/**`
- `web/src/routes/shelves/**`
- New search and shelf API types/helpers/components under `web/src/lib/`
- Search and shelf UI tests alongside owned source files
- Necessary shelf-filter integration in the W1 library route and catalog components

**Shared files (append-only, see plan §4):**
- `web/src/lib/nav.ts` — append search and shelves navigation entries
- `web/messages/en.json` and `web/messages/zh.json` — add matching W4 keys only
- `web/src/routes/+layout.svelte` — modify only if needed to expose navigation/search;
  preserve auth, locale switching, and shell behavior
- `web/package.json` / `web/pnpm-lock.yaml` — only if a required dependency is justified
- [progress/README.md](../progress/README.md) — edit only the W4 row and append a W4 log

**Must not touch:**
- `internal/**`, database migrations, or any API contract
- Reader, offline sync, notes/export, stats, metadata, or admin UI
- Generated `web/src/lib/paraglide/**` or unrelated W1 behavior

## Requirements

1. Use the existing typed API client, S1/SH1 response DTOs, W1 book components, Paraglide
   messages, and app shell. Handle `ApiError`, network failures, loading, empty, retry,
   validation, and end-of-list states explicitly. Do not duplicate backend visibility or
   permission rules in client-side filters.
2. Add a search field reachable from the app shell and a `/search` page. Submit to
   `GET /api/v1/search?q=...&limit=...&cursor=...`; preserve the query in the URL, reset
   pagination when it changes, and pass the server's `next_cursor` back verbatim with the
   same query. Never synthesize offsets or client-sort a page. Render the S1 result DTO
   (title, ordered authors, optional series/cover, and rank) with a link to the W1 book
   detail route and accessible cover alt text.
3. Support keyboard submission, clear/reset, empty query, loading, no-results, API-error,
   and pagination states. Avoid issuing duplicate requests while a request is pending.
   Treat cursor/query validation errors as a prompt to restart search, not as an empty
   success.
4. Add `/shelves` to list the viewer's private and shared shelves using
   `GET /api/v1/shelves`; add `/shelves/{id}` to show shelf metadata and paged books using
   `GET /api/v1/shelves/{id}/books`. Consume both standard page envelopes and use each
   returned cursor verbatim. Reuse W1 book cards/list behavior and link book entries to
   `/books/{id}`.
5. Implement private shelf creation, rename/description editing, deletion, and add/remove
   book controls using the SH1 routes and exact request/response shapes. Offer shared shelf
   creation only when the authenticated session identifies an administrator; regardless
   of the displayed role, handle 403/404 from the API explicitly. Do not invent access to
   another user's private shelf. Confirm destructive shelf deletion and communicate that
   deleting a shelf does not delete its books.
6. Provide a way to add a visible book to an accessible shelf and remove a member from a
   shelf. Reuse the shelf-book API's optional position behavior only if the UI explicitly
   exposes reordering; otherwise append and preserve server order. Surface conflicts,
   permission failures, hidden/inaccessible books, and stale-cursor errors without
   leaking book or shelf information.
7. Integrate the available shelf filter into the library page without changing existing
   W1 filtering/sorting/pagination behavior: fetch only the viewer-visible shelves, retain
   the selected shelf in URL state, clear the book-page cursor when filters change, and
   continue using the existing library book API for ordinary library filters. If the
   existing APIs do not provide a shelf filter on the library endpoint, link to the shelf
   page rather than filtering a page of books client-side.
8. Add complete, natural English and Chinese strings for all new controls, headings,
   validation, loading, empty, error, and confirmation states. Keep keyboard navigation,
   focus-visible styles, semantic headings, responsive layouts, and accessible labels.
9. Add focused Vitest tests for request helpers and UI state transitions (query/cursor
   reset, loading/error/empty/pagination, shelf permissions, CRUD outcomes, and localized
   copy) plus Playwright coverage for the main search and shelf flows. Use the existing
   test setup; do not add tooling without need.

## Out of scope

- Backend search/shelf behavior or API changes (S1/SH1)
- Notes, highlights, stats, or exports UI (W7)
- Reader or offline behavior (W2/W3)
- Administration pages or metadata merge UI (W5/W6)

## Acceptance criteria

- [x] Search uses S1's authenticated API, DTO, ranking, and opaque cursor correctly.
- [x] Users can list and manage their permitted shelves and browse visible shelf books.
- [x] Existing library browse behavior remains intact; no client-side access filtering is
  used as a substitute for server enforcement.
- [x] All new user-facing copy exists in English and Chinese and key interactions are
  keyboard accessible.
- [x] `pnpm --dir web check`, `pnpm --dir web test`, `pnpm --dir web build`, and focused
  Playwright tests pass.

## Validation commands

```powershell
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:e2e -- --workers=2
```

## Hand-off

- Update this prompt's status and W4's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Keep shared W1 components and URL conventions reusable. Record any API limitation rather
  than changing S1 or SH1 contracts.
- Update architecture docs or add an ADR only if the accepted design changes.

## Implementation hand-off

- Search is `GET /api/v1/search` with the S1 DTO and opaque query/viewer-bound cursor;
  result cover URLs and IDs are already visibility-filtered by the server.
- Shelf list and book pages use `GET /api/v1/shelves` and
  `GET /api/v1/shelves/{id}/books`; both use `{"items":[...],"next_cursor":null|string}`,
  default limit 50, maximum 100. Shelf permissions, visible counts, and hidden-book
  filtering come from SH1. `PUT /api/v1/shelves/{id}/books/{bookID}` adds or moves a
  visible book; `DELETE` removes it. `POST`, `PATCH`, and `DELETE /api/v1/shelves[/{id}]`
  implement the SH1 create/update/delete contracts.

## W4 implementation notes

- Search: `web/src/lib/search/` (`api.ts`, `SearchBox.svelte` in the app shell, hidden on
  `/search`, and `SearchResultCard.svelte`) and `web/src/routes/search/`. Only `q` is kept
  in the URL; the cursor lives in page state and is reset whenever `q` changes. A first-page
  400 sends the user back to the input; a later-page 400 restarts from page one. Queries over
  4,096 UTF-8 bytes are rejected before sending. A negative BM25 rank is shown as a positive
  relevance score; rank `0` (unranked substring match) shows no score.
- Shelves: `web/src/lib/shelves/` (API helpers, validation, `ShelfForm`, `AddToShelf`,
  `ShelfLinks`) and `web/src/routes/shelves/`. Management controls are offered for the
  viewer's own private shelves and for every shelf when `/auth/me` reports `role: "admin"`.
  This is only a UI hint: every mutation still reports 403/404/409 from SH1. Membership
  changes reload page one because SH1 shelf-book cursors become stale. Reordering is not
  exposed, so `PUT` always sends `{}` and preserves server order.
- `web/src/lib/paging/CursorPager.svelte.ts` is a reusable rune-based pager. It aborts and
  ignores superseded requests and never duplicates a pending first or next page.
- W1 integration: `BookCard` accepts an optional `actions` snippet; the book detail page
  shows "Add to shelf" when online. **API limitation:** `GET /api/v1/books` has no
  `shelf_id` filter, so the library page lists the viewer's shelves as links to
  `/shelves/{id}` instead of filtering library books on the client. If a future API adds the
  filter, wire it through `bookFiltersFromSearch`/`setCatalogFilter` so cursor resets keep
  working.
