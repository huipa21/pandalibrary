# W7: Stats, notes and export UI

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § Step 10
- Depends on (merged): ST1, E1, W2
- Can run in parallel with: W5, W6
- Branch / worktree: `task/w7` in `..\pandalibrary-w7`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§5, 8, 12–13, 15
- [architecture/database.md](../architecture/database.md) §§1–5, 8
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- [ST1 stats response and timezone contract](./ST1-stats-api.md),
  [E1 notes export contract](./E1-notes-export.md),
  [R1 annotation-search contract](./R1-reading-sync-api.md), and the merged reader
  Markdown safety, API, navigation, localization, and test patterns

## Goal

Add a timezone-aware reading dashboard, searchable personal notes/highlights, and safe
single-book or multi-book annotation export using the completed ST1, R1, and E1 APIs.

## Scope

**Owns (create/modify freely):**
- `web/src/routes/stats/**`
- `web/src/routes/notes/**`
- Stats, annotation-search, and export helpers/types/components/tests under `web/src/lib/`
- Focused UI tests alongside owned source files

**Shared files (append-only, see plan §4):**
- `web/src/lib/nav.ts` — append stats and notes navigation entries
- `web/messages/en.json` and `web/messages/zh.json` — add matching W7 keys only
- `web/package.json` / `web/pnpm-lock.yaml` — add a chart dependency only if needed;
  architecture names LayerChart, but it is not currently listed in the web manifest
- [progress/README.md](../progress/README.md) — edit only the W7 row and append a W7 log

**Must not touch:**
- `internal/**`, migrations, API contracts, generated `web/src/lib/paraglide/**`
- Reader annotation editing/sync behavior (W2/R1), metadata/admin UI (W5/W6), or offline
  storage/sync

## Requirements

1. Add `/stats` and `/notes` routes using the authenticated API client and existing app
   shell. Add both navigation items without restructuring shared navigation. Handle
   loading, empty, API validation, network, `401`, and retry states explicitly.
2. Build the stats range controls from inclusive local calendar dates. Default to a
   reasonable recent range ending today and use
   `Intl.DateTimeFormat().resolvedOptions().timeZone` for the browser's IANA timezone.
   Send all three required parameters to `GET /api/v1/stats`; do not convert dates to UTC
   or approximate a local day as 24 hours. Validate range order and the 366-day limit
   before submitting, and display server validation errors without dropping the user's
   selections.
3. Render all ST1 response sections: daily reading time/session counts, finished books
   by month, current/longest streaks, and time per book. Preserve server order and
   zero-filled dates/months; format seconds for display without changing the underlying
   values. Provide responsive charts with an accessible text/table equivalent. Follow
   architecture's LayerChart direction when appropriate; if adding it, add only the
   required dependency and lockfile update. Never hide chart data from keyboard or
   assistive-technology users.
4. Add a searchable notes/highlights page using the existing
   `GET /api/v1/search/annotations?q=...` API. Render the returned `id`, `book_id`,
   `kind`, `content`, `position`, and `created_at`; keep result order, debounce or submit
   intentionally, avoid duplicate in-flight requests, and handle empty-query and short
   query behavior exactly as the API defines it. Link each result to the corresponding
   book/reader entry without fetching one book per result. Do not invent pagination or a
   general notes-list endpoint if the search API does not provide one.
5. Treat annotation bodies as untrusted Markdown. Prefer a plain-text excerpt; if rendering
   previews, reuse the existing Markdown renderer and DOMPurify/safe-content path. Never
   inject raw annotation HTML. Do not provide edit/delete controls or attempt to change
   annotation sync semantics.
6. Allow selecting distinct books represented by the visible search results for export,
   with clear select/deselect controls and the E1 maximum of 100 distinct book IDs. Send
   exactly one `book_ids` query parameter to the implemented
   `GET /api/v1/me/notes/export` route. One selected book downloads Markdown; multiple
   selected books download ZIP. The E1 route is the implemented contract; do not use the
   stale `/api/v1/export/notes` path in the architecture route summary.
7. Download export responses as blobs using same-origin credentials, `cache: no-store`,
   and redirect rejection. Parse the attachment filename safely (including
   `filename*`), preserve server-provided names, and never place response content into
   HTML. For `application/problem+json`, show a useful error; do not treat an error body
   as a successful download. Revoke temporary object URLs after download.
8. Keep stats and annotation search in the authenticated viewer scope; do not send user IDs
   or attempt client-side visibility filtering. Use the server's timezone, visibility,
   ownership, selection, and export rules as authoritative.
9. Add natural English and Chinese strings for all controls, data labels, loading/empty/
   error states, selection counts, and download outcomes. Ensure date inputs, charts,
   note results, and export selection are keyboard accessible and responsive.
10. Add focused Vitest coverage for date/timezone query construction, 366-day validation,
    chart empty/zero states, annotation search state, export selection limits, filename
    handling, and problem responses. Add Playwright coverage for a stats range, note
    search, and single/multi-book export. Use existing tooling unless a chart dependency
    is justified.

## Out of scope

- Stats calculations or reading/annotation API changes (ST1/R1)
- Annotation editing/deletion and offline behavior (W2/W3)
- Export format or server-side export changes (E1)
- Administration or metadata merge screens (W5/W6)

## Acceptance criteria

- [x] Stats requests use inclusive date strings and the browser's IANA timezone; all ST1
  response sections are represented with accessible alternatives.
- [x] Users can search their own annotations and download one-book Markdown or multi-book
  ZIP exports through E1's exact route and filename contract.
- [x] Errors, empty states, limits, and selection changes are explicit and recoverable.
- [x] All new user-facing copy exists in English and Chinese and is keyboard accessible.
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

- Update this prompt's status and W7's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record the chosen chart implementation, annotation-search constraints, and download
  behavior. Update architecture docs or add an ADR only if the accepted design changes.

## Implementation hand-off

- **Charts:** no chart dependency was added (LayerChart not used). `lib/stats/BarChart.svelte`
  renders a lightweight inline SVG (`role="img"`, summary `aria-label`, per-bar `<title>`);
  every chart is paired with a data table (daily table in a focusable scroll region), so the
  tables are the accessible alternative. Streaks and totals are shown as summary cards.
- **Stats requests:** `from`/`to` are local inclusive `YYYY-MM-DD` strings (default last 30
  days, presets 7/30/90/365) and `timezone` comes from `Intl.DateTimeFormat().resolvedOptions()`.
  Reversed and >366-day ranges are rejected client-side; server 400 details are shown verbatim.
- **Annotation search:** R1 has no pagination, returns at most 100 results newest first, and
  requires 1–200 code points (queries under 3 use substring matching; the UI hints at this).
  Results carry no book titles, so they are labelled "Book {id}" and link to `/books/{id}`
  without extra fetches. Position is shown only for highlights (notes report `0`). The query
  lives in `?q=`; superseded requests are aborted and identical in-flight queries deduped.
- **Downloads:** export calls `GET /api/v1/me/notes/export?book_ids=…` (max 100 books from the
  visible results; selection resets when the query changes). One book must return
  `text/markdown`, several `application/zip`; the filename comes from `Content-Disposition`
  (`filename*` preferred) and is sanitized. The blob is saved via an object URL revoked after
  a 1 s delay. 400/401/404/413/5xx and connection failures map to recoverable messages.
- Validation: `pnpm --dir web check` (0 errors), `pnpm --dir web test` (161 pass, 39 W7),
  `pnpm --dir web build`, and `src/routes/stats-notes.e2e.ts` (4 browser tests) pass.
