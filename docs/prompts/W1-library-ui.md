# W1: Library UI

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § W1
- Depends on (merged): C1
- Can run in parallel with: R1, X2, X3
- Branch / worktree: `task/w1` in `..\pandalibrary-w1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§5, 12, 15
- [architecture/database.md](../architecture/database.md) §§1–5
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- The merged C1 API DTOs and handlers in `internal/catalog/types.go` and
  `internal/httpapi/catalog.go`
- `web/src/lib/api/client.ts`, `web/src/lib/nav.ts`, `web/src/routes/+layout.svelte`,
  existing auth/settings pages, `web/messages/en.json`, and `web/messages/zh.json`

## Goal

Build the first usable catalog browsing experience on the existing authenticated C1 API.
Users can choose an accessible library, browse and filter its books with stable keyset
pagination, open a book detail page, and browse authors, series, and tags in English or
Chinese.

## Scope

**Owns (create/modify freely):**
- `web/src/routes/+page.svelte` — replace the placeholder home with accessible libraries
- `web/src/routes/library/**`
- `web/src/routes/books/[id]/**`
- `web/src/routes/authors/**`
- `web/src/routes/series/**`
- `web/src/routes/tags/**` — use numeric tag IDs to match the C1 API
- New shared catalog types, API helpers, and components under `web/src/lib/catalog/**`
- Catalog UI tests alongside owned source files

**Shared files (append-only, see plan §4):**
- `web/src/lib/nav.ts` — add the library/catalog top-level navigation entry
- `web/messages/en.json` and `web/messages/zh.json` — add matching W1 message keys without
  changing or reformatting existing entries
- `web/src/routes/+layout.svelte` — only if needed to expose the new navigation entry;
  preserve auth, locale switching, and shell behavior
- `web/package.json` / `web/pnpm-lock.yaml` — only if a required dependency is justified;
  take both sides on lockfile conflicts
- [progress/README.md](../progress/README.md) — edit only the W1 row and append a W1 log

**Must not touch:**
- `internal/**`, database migrations, or backend API contracts
- `web/src/routes/read/**`, reader code, service worker, sync/outbox, or settings
- Search, shelves, admin, metadata editing, or the generated `web/src/lib/paraglide/**`

## Requirements

1. Use the existing typed `api` client and C1 JSON DTOs. Do not duplicate or alter backend
   response shapes. Handle `ApiError` and network failures explicitly in the UI; show
   localized loading, empty, retry/error, and pagination states.
2. Make `/` list the current user's accessible libraries using `GET /libraries`, with
   links to `/library/{id}`. Libraries are already visibility-filtered by the API; do not
   infer access from role or expose guessed IDs.
3. Implement `/library/{id}` using `GET /libraries/{id}` and
   `GET /books?library_id={id}`. Provide:
   - Grid and list presentation with reusable book cards/rows.
   - Title, recently-added, and series sort controls (`sort=title|added|series`); series
     sort is available only with a series filter.
   - Author, series, and tag filters using the C1 entity APIs and URL query state.
   - Keyset pagination using the returned `next_cursor` verbatim, a bounded page size
     (default 50, maximum 100), and a way to clear filters/reset pagination.
   - Stable user-visible ordering from the server; do not client-sort one page or synthesize
     offsets from cursor values.
4. Implement `/books/{id}` using `GET /books/{id}`. Display bibliographic fields,
   contributors and roles, series/index, tags, identifiers, available formats and sizes,
   cover and provenance where present. Keep nullable fields and empty arrays safe.
   Provide links to each returned hash-versioned `download_url`; do not implement a reader
   or rewrite file URLs.
5. Implement browse and detail views for authors, series, and tags using
   `GET /authors`, `/series`, `/tags` and their `/{id}` endpoints. Use each entity's
   `visible_book_count`; detail pages list books via `/books?author_id=…`,
   `/books?series_id=…`, or `/books?tag_id=…` and share the same card/list, sorting, and
   keyset-pagination behavior. Do not fetch or expose invisible books.
6. Use routes consistent with the C1 router, including numeric IDs for tags. Use only
   features available from C1: status filters depend on R1 and shelves/search belong to
   later tasks, so do not make this task depend on either API.
7. Add complete, natural English and Chinese message keys for every new user-facing label,
   action, and error. Use Paraglide messages instead of hard-coded UI copy, and verify
   both locales render without missing keys.
8. Keep the UI keyboard accessible and responsive. Provide meaningful link/button labels,
   image alt text, focus-visible states, and semantic headings. Preserve the existing
   auth-aware app shell and client-side routing.
9. Add focused tests for catalog API helpers and important UI state transitions such as
   filters/sort resetting the cursor, end-of-list handling, loading/error/empty states,
   and localized copy. Use the repository's existing Vitest and Playwright setup; do not
   add new test tooling without need.

## Out of scope

- Reading, progress editing, highlights, and offline behavior (R1, W2, W3)
- Search and shelves (S1, SH1, W4)
- Uploads, admin pages, and metadata merge UI (I1, M1, W5, W6)
- Changes to catalog API behavior or DTOs

## Acceptance criteria

- [x] Users can browse accessible libraries, filter and sort books, page through results,
  and open book detail pages from real C1 API responses.
- [x] Author, series, and tag indexes/details use viewer-filtered C1 APIs and link to
  correctly filtered books.
- [x] Grid/list controls and all catalog states work at mobile and desktop widths.
- [x] Every new UI string has matching English and Chinese translations.
- [x] `pnpm --dir web check`, `pnpm --dir web test`, and `pnpm --dir web build` pass.
- [x] No reader, search, shelves, or backend feature is introduced.

## Validation commands

```powershell
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
```

## Hand-off

- Update this prompt's status and W1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Keep shared catalog components and request helpers suitable for the search/shelves UI
  task W4; note any API limitation rather than changing the C1 contract.
- Update architecture docs or add an ADR only if the accepted design changes.
