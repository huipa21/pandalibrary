# Progress

Status values: `Not started` · `Prompt drafted` · `Ready` · `In progress` · `Review` ·
`Done` · `Blocked (reason)`.

Rules: each session edits only its own task's row and appends to the log. Plan:
[implementation-plan.md](../plans/implementation-plan.md).

## Board

| Step | Task | Title | Deps | Prompt | Status | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 1 | F1 🔒 | Repository scaffold | — | [F1-repo-scaffold.md](../prompts/F1-repo-scaffold.md) | Done | `task/f1` | Merged into master after F2/F3/X1 |
| 2 | F2 | Database and migration runner | F1 | [F2-db-migrations.md](../prompts/F2-db-migrations.md) | Done | `master` | sqlc check, build, lint, and full tests pass |
| 2 | F3 | Web scaffold | F1 | [F3-web-scaffold.md](../prompts/F3-web-scaffold.md) | Done | | Static fallback embedded; F4 must route SPA paths to it |
| 2 | X1 | Extraction core, EPUB, covers | F1 | [X1-extraction-epub-covers.md](../prompts/X1-extraction-epub-covers.md) | Done | `master` | FB2 BOM/Windows-1251, typed XML rejection, and exact 64 KiB probe tests pass; full Go gates pass |
| 3 | F4 🔒 | Server skeleton | F2, F3 | [F4-server-skeleton.md](../prompts/F4-server-skeleton.md) | Done | `master` | Server, health, SPA, middleware, and shutdown; F2/X1 review closed |
| 4 | A1 🔒 | Auth vertical slice | F4 | [A1-auth-vertical-slice.md](../prompts/A1-auth-vertical-slice.md) | Done | `master` | Auth setup, sessions, app passwords, CLI, and web flows; checks pass |
| 5 | C1 🔒 | Catalog core | A1 | [C1-catalog-core.md](../prompts/C1-catalog-core.md) | Done | `master` | Catalog, ACLs, metadata, media, and FTS; F2/X1 review closed |
| 6 | R1 | Reading and sync API | C1 | [R1-reading-sync-api.md](../prompts/R1-reading-sync-api.md) | Done | `master` | Push/pull DTO and schema deletion limits recorded in prompt hand-off |
| 6 | W1 | Library UI | C1 | [W1-library-ui.md](../prompts/W1-library-ui.md) | Done | `master` | Bilingual catalog browsing, filters, keyset paging and details; frontend checks and browser tests pass |
| 6 | X2 | PDF and CBZ extractors | X1 | [X2-pdf-cbz-extractors.md](../prompts/X2-pdf-cbz-extractors.md) | Done | `master` | PDF/CBZ registration and fixture tests; pdfcpu v0.16.4 |
| 6 | X3 | MOBI/AZW3 and FB2 extractors | X1 | [X3-mobi-fb2-extractors.md](../prompts/X3-mobi-fb2-extractors.md) | Done | `master` | Unblocked: both formerly skipped plain-FB2 registry cases revalidated; focused and full Go gates pass |
| 7 | W2 | Reader UI | R1, W1 | [W2-reader-ui.md](../prompts/W2-reader-ui.md) | Done | `master` | Seven-format bilingual reader, R1 progress/annotations/settings/sessions, isolated book content; frontend checks and browser tests pass |
| 7 | I1 | Importer | C1, X1 | [I1-importer.md](../prompts/I1-importer.md) | Done | `master` | Durable uploads/drop imports, two workers, recovery, formats/FTS/covers; Go gates pass; importer registry covers FB2 BOM/Windows-1251 |
| 7 | S1 | Search | C1 | [S1-search.md](../prompts/S1-search.md) | Done | `master` | Authenticated FTS/short-query search with visibility and query-bound pagination; checks pass |
| 7 | SH1 | Shelves | C1 | [SH1-shelves.md](../prompts/SH1-shelves.md) | Done | `master` | Private/shared shelves, visibility-filtered manual ordering, and paged APIs; checks pass |
| 8 | W3 | Offline PWA | W2 | [W3-offline-pwa.md](../prompts/W3-offline-pwa.md) | Done | `master` | Account-scoped downloads/outbox, atomic revision pulls, offline reader and storage controls; frontend checks, 53 unit and 21 browser tests pass |
| 8 | K1 | KOReader sync | R1, I1 | [K1-koreader-sync.md](../prompts/K1-koreader-sync.md) | Done | `master` | Protocol/bridge/session tests pass; no device available, safe XPointer fallback enabled; all required Go gates pass |
| 8 | M1 | Metadata providers | C1, X1 | [M1-metadata-providers.md](../prompts/M1-metadata-providers.md) | Done | `master` | Four bounded/cached providers, admin config, atomic per-field apply/provenance and safe covers; Go gates pass |
| 8 | J1 | Maintenance jobs | I1, R1 | [J1-maintenance-jobs.md](../prompts/J1-maintenance-jobs.md) | Done | `master` | Bounded maintenance/admin controls, verified retained backups, safe orphan sweep; all required Go gates pass |
| 9 | ST1 | Stats API | R1 | [ST1-stats-api.md](../prompts/ST1-stats-api.md) | Done | `master` | Authenticated, bounded timezone-aware SQL aggregates; DST, streaks, visibility, limits and HTTP failure tests; all required Go gates pass |
| 9 | E1 | Notes export | R1 | [E1-notes-export.md](../prompts/E1-notes-export.md) | Done | `master` | Authenticated Markdown/ZIP export; visibility, ordering, YAML, filename, and HTTP coverage; Go gates pass |
| 9 | O1 | OPDS | S1, SH1 | [O1-opds.md](../prompts/O1-opds.md) | Done | `master` | Basic-auth OPDS 1.2 navigation/acquisition feeds, OpenSearch, 50-entry paging, visibility on every feed/download; schema-rule and r2-opds-js client checks; all required Go gates pass |
| 9 | W4 | Search and shelves UI | S1, SH1, W1 | [W4-search-shelves-ui.md](../prompts/W4-search-shelves-ui.md) | Done | `master` | Bilingual shell/page search with opaque cursors, shelf list/detail/CRUD/membership UI, library shelf links; check, 73 unit and 24 browser tests pass |
| 10 | W7 | Stats, notes and export UI | ST1, E1, W2 | [W7-stats-notes-export-ui.md](../prompts/W7-stats-notes-export-ui.md) | Done | `master` | `/stats` (SVG charts + tables, local dates/timezone) and `/notes` (annotation search, Markdown/ZIP export); check, 39 unit and 4 browser tests pass |
| 10 | W5 | Admin UI | I1, M1, W1, J1 | [W5-admin-ui.md](../prompts/W5-admin-ui.md) | Done | `master` | `/admin` libraries/access, hide lists, uploads + polled import history, providers, maintenance; check, 29 unit and 7 browser tests pass; user-list/account API still missing (ID-based workflow) |
| 10 | W6 | Metadata merge UI | M1, W1 | [W6-metadata-merge-ui.md](../prompts/W6-metadata-merge-ui.md) | Done | `master` | Admin `/books/{id}/edit` per-field candidate merge via request-key references, server-proxied cover previews, 409 re-lookup, sequential pdf.js first-page cover batch; check, 20 unit and 3 browser tests pass |
| 11 | Q1 🔒 | Release and end-to-end | all | [Q1-release-e2e.md](../prompts/Q1-release-e2e.md) | Done | `master` | Scratch image 11.3 MiB compressed; runtime/health/shutdown, 39 real-server browser tests, upgrade checks, and Go/web gates pass locally; release/CI workflows wired |

## Sidebar/dashboard follow-up board

Plan and parallel ownership rules:
[sidebar-dashboard-plan.md](../plans/sidebar-dashboard-plan.md).
These are local issue specifications, not published GitHub issues. Wave numbers
below are local to this follow-up; merge a wave before starting the next.

| Wave | Task | Title | Deps | Prompt | Status | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 1 | UX1 | Sidebar shell and All Books | baseline | [UX1](../prompts/UX1-sidebar-shell.md) | Done | `task/ux1` | Shell, `/books`, `/libraries`; shelves/footer slots for UX3/UX10 |
| 1 | UX2 | System and automatic shelves API | baseline | [UX2](../prompts/UX2-system-smart-shelves.md) | Done | `task/ux2` | Only migration writer in wave 1 |
| 1 | UX7 | Admin users API | baseline | [UX7](../prompts/UX7-admin-users-api.md) | Done | `task/ux7` | Admin CRUD/paging, atomic lockout/actor guards and all-credential revocation; Go/sqlc gates pass; UX8 hand-off recorded |
| 1 | UX9 | Commit-based dev/image version | baseline | [UX9](../prompts/UX9-build-version.md) | Done | `master` | Public version API/CLI, stamped builds, and standalone footer; UX10 wires it |
| 2 | UX3 | Sidebar shelves and reusable shelf UI | UX1, UX2 | [UX3](../prompts/UX3-shelf-navigation-ui.md) | Done | `task/ux3` | Reused by dashboard |
| 2 | UX4 | Dashboard feeds API | UX2 | [UX4](../prompts/UX4-dashboard-feeds-api.md) | Done | `task/ux4` | Keyset pagination, visibility-safe SQL, hand-off ready for UX5 |
| 2 | UX6 | Bookmarks and offline reader sync | UX1, UX2 | [UX6](../prompts/UX6-bookmarks.md) | Done | `master` | Validated saved positions, paged visible list, durable offline replay and exact PDF/CFI jumps |
| 2 | UX8 | Admin users UI and selectors | UX7 | [UX8](../prompts/UX8-admin-users-ui.md) | Done | `master` | Complete account lifecycle, self-session retirement and paged identity selectors |
| 3 | UX5 | Configurable dashboard | UX3, UX4 | [UX5](../prompts/UX5-configurable-dashboard.md) | Done | `master` | Full frontend check, units, build and dashboard browser tests pass |
| 4 | UX10 | Integration and verification gate | UX1-UX9 | [UX10](../prompts/UX10-layout-integration.md) | Done | `master` | 58 browser / 204 unit tests, Go/sqlc gates, v1 preservation and actual 11.4 MiB scratch image/restart pass |

## Bookheap follow-up board

Plan, decisions, API contract and ownership rules:
[bookheap-plan.md](../plans/bookheap-plan.md). Merge a wave before starting
the next.

| Wave | Task | Title | Deps | Prompt | Status | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 1 | BH1 | Heap folder, index table, upload/list/delete/scan API | baseline | [BH1](../prompts/BH1-bookheap-storage-api.md) | Done | `task/bh1` | Migration 00004; delete adds `changed`/`failed` codes |
| 1 | BH3 | Header Upload button and upload dialog | baseline | [BH3](../prompts/BH3-upload-dialog.md) | Done | `task/bh3` | Upload verified against the real server by BH5 |
| 2 | BH2 | Bulk assign to library + shelves via importer | BH1 | [BH2](../prompts/BH2-bookheap-assign-api.md) | Done | `task/bh2` | No migration; adds per-item `changed`/`failed`; importer hook |
| 2 | BH4 | Bookheap page, nav, Scan, bulk Assign/Delete | BH1, BH3 | [BH4](../prompts/BH4-bookheap-page.md) | Done | `task/bh4` | Live assignment verified by BH5; Queued/Importing filter merged client-side |
| 3 | BH5 | Real-server integration, docs, release gates | BH1-BH4 | [BH5](../prompts/BH5-bookheap-integration.md) | Done | `task/bh5` | Fixed hook-lookup deadlock; 6 real-server E2E + restart check |

## Book View follow-up board

Plan, decisions, API/frontend contracts and ownership rules:
[book-view-plan.md](../plans/book-view-plan.md). Merge a wave before starting
the next. Only BV10 runs the full verification gate.

| Wave | Task | Title | Deps | Prompt | Status | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 1 | BV1 | Catalog API: file name/added, shelves containing a book | baseline | [BV1](../prompts/BV1-catalog-detail-api.md) | Done | `task/bv1` | No migration; control chars in file names become `_` |
| 1 | BV2 | Per-book reading log API + web client | baseline | [BV2](../prompts/BV2-reading-log-api.md) | Done | `task/bv2` | Clarifications in plan; `stopped` attempts currently unreachable |
| 1 | BV3 | Cover kit: generated cover, format badge, hover actions | baseline | [BV3](../prompts/BV3-cover-kit.md) | Done | `master` | Cover kit and card integration; targeted checks pass |
| 1 | BV4 | Details shell: route group, tabs, contexts, prev/next | baseline | [BV4](../prompts/BV4-details-shell.md) | Done | `task/bv4` | `getBookContext()` shape in the log |
| 2 | BV5 | Quick view drawer | BV1, BV3 | [BV5](../prompts/BV5-quick-view.md) | Done | `task/bv5` | Contains a BV1 merge; status menu opens upward via a CSS override |
| 2 | BV6 | Details tab | BV1-BV4 | [BV6](../prompts/BV6-details-tab.md) | Done | `task/bv6` | Offline Details is read-only; legacy file controls stay until BV7 |
| 2 | BV7 | Files tab | BV1, BV3, BV4 | [BV7](../prompts/BV7-files-tab.md) | Done | `task/bv7` | Grouped files, per-copy progress and offline actions; targeted checks pass |
| 2 | BV8 | Reading Log tab | BV2-BV4 | [BV8](../prompts/BV8-reading-log-tab.md) | Done | `task/bv8` | Local progress ring for BV10 to deduplicate |
| 2 | BV9 | Highlights tab + reader `?highlight=` | BV3, BV4 | [BV9](../prompts/BV9-highlights-tab.md) | Done | `task/bv9` | Branch includes merged `task/bv4` |
| 3 | BV10 | Integration, real-server E2E, visual QA, full gate | BV1-BV9 | [BV10](../prompts/BV10-integration.md) | Done | `task/bv10` | All BV branches merged; full gate green; architecture in [book-view.md](../architecture/book-view.md) |

## Book Cover follow-up board

Plan, decisions, contracts and ownership rules:
[book-cover-plan.md](../plans/book-cover-plan.md). Merge a wave before starting
the next. Only BC8 runs the full verification gate.

| Wave | Task | Title | Deps | Prompt | Status | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 1 | BC1 | 8 reading statuses, status icons, Image-3 status menu | baseline | [BC1](../prompts/BC1-reading-statuses.md) | Done | `master` (uncommitted) | Migration 00005; status kit API in log |
| 1 | BC2 | Batched `/me/book-states` API + client store | baseline | [BC2](../prompts/BC2-book-states.md) | Done | `task/bc2` | No migration; store API in log |
| 1 | BC3 | Cloth generated cover + `--spacing-book` / `--aspect-book` tokens | baseline | [BC3](../prompts/BC3-cloth-cover.md) | Done | `master` (uncommitted) | 158 / 257.5 px covers; 13rem token |
| 2 | BC4 | Cover tile: lift, status badge, hover progress, cover-only cards | BC1-BC3 | [BC4](../prompts/BC4-cover-tile.md) | Done | `master` (uncommitted) | Cover-only cards; actions retained for BC6; BC2 prerequisite applied |
| 2 | BC5 | Bookheap grid view + unified heap covers | BC3 | [BC5](../prompts/BC5-bookheap-covers.md) | Done | `master` (uncommitted) | Saved Grid/List; shared covers; 208 px grid tiles; targeted gates pass |
| 3 | BC6 | Dashboard rows: no Resume button, standard width | BC4 | [BC6](../prompts/BC6-dashboard-tiles.md) | Done | `master` (uncommitted) | Cover-only rows at `w-book`; Play resumes; `ux5.resume*` keys removed |
| 3 | BC7 | All Books / shelves / related: standard grid | BC4 | [BC7](../prompts/BC7-catalog-grids.md) | Done | `master` (uncommitted) | `.book-grid` everywhere; related carousel `w-book`; compact shelf remove button |
| 4 | BC8 | Integration, real-server E2E, visual QA, full gate | BC1-BC7 | [BC8](../prompts/BC8-integration.md) | Blocked | `master` (uncommitted) | Full gate and written-spec visual QA pass; original reference-image comparison unavailable |

## Header Menu follow-up board

Plan, decisions and implementation contract:
[header-menu-plan.md](../plans/header-menu-plan.md).

| Wave | Task | Title | Deps | Prompt | Status | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 1 | HM1 | Icon header, language picker, app theme and account menu | UX1, UX10, BH3 | [HM1](../prompts/HM1-header-menu.md) | Done | `task/hm1` | Responsive shell and locale/theme controls implemented; targeted checks pass; full page-by-page visual contrast review remains a follow-up |

## Book Detail follow-up board

Plan, decisions, contracts and ownership rules:
[book-detail-plan.md](../plans/book-detail-plan.md). Merge a wave before
starting the next. In wave 1, merge BD2 (migration 00006) before BD3 (00007).
Only BD8 runs the full verification gate.

| Wave | Task | Title | Deps | Prompt | Status | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 1 | BD1 | Back icon with origin return, previous/next fix, Activities tab | baseline | [BD1](../prompts/BD1-back-navigation.md) | Done | `task/bd1` | Fixes reader round-trip reopening the reader |
| 1 | BD2 | Automatic status lifecycle + re-read restart | baseline | [BD2](../prompts/BD2-status-lifecycle.md) | Ready | `task/bd2` | Migration 00006 (backfill); merge before BD3 |
| 1 | BD3 | Multi-user reviews: storage, API, web client | baseline | [BD3](../prompts/BD3-reviews-api.md) | Ready | `task/bd3` | Migration 00007; notes stay private |
| 1 | BD4 | Hero cleanup + borderless status control | baseline | [BD4](../prompts/BD4-hero-status-control.md) | Ready | `task/bd4` | New `inline` variant only |
| 1 | BD5 | Shelf tags with X + Add-to-shelf popover button | baseline | [BD5](../prompts/BD5-shelf-tags.md) | Ready | `task/bd5` | Components only; wired by BD7 |
| 1 | BD6 | Details card: edit icon + metadata sources | baseline | [BD6](../prompts/BD6-details-card.md) | Ready | `task/bd6` | Reads `canEditMetadata` from context |
| 2 | BD7 | Overview + Reviews cards, Details tab assembly | BD3-BD6 | [BD7](../prompts/BD7-overview-reviews-assembly.md) | Ready | `task/bd7` | Sole owner of `DetailsTab.svelte` |
| 3 | BD8 | Integration, real-server E2E, visual QA, docs, full gate | BD1-BD7 | [BD8](../prompts/BD8-integration.md) | Ready | `task/bd8` | Prunes unused message keys |

## Log

Newest first. Format: `YYYY-MM-DD — <task> — what happened (decisions, blockers, follow-ups)`.

- 2026-11-08 — BD1 — The book header's "‹ Books" is now a round arrow-left
  icon ("Back to {label}") that returns to the page the book was opened from,
  including after reader and metadata-editor round trips. `book-origin.ts` API:
  `BOOK_ORIGIN_KEY`, `BookOrigin { href, label | null }`, `isBookArea`,
  `isBookChildFlow(pathname, bookId?)`, `rememberBookOrigin(href, label?)`,
  `readBookOrigin()`, `originLabel(href)`, plus `rememberOriginScroll`,
  `readOriginScroll` and `restoreOriginScroll`. The scroll helpers were added because
  the router restores the Dashboard scroll before its rows load, which clamps it to 0.
  Caveats: `/` always labels as "Dashboard" (not the row); `/login` and
  `/setup` are never origins; popstate arrivals never use `history.back()`.
  `browseNeighbors(bookId, originHref)` hides previous/next for other lists;
  Dashboard rows record their context on tile activation. Reading Log →
  Activities: the route is `(tabs)/activities`. Legacy `(tabs)/reading-log`
  is a `+page.ts` load redirect (307, keeps the query) with a placeholder
  `+page.svelte`. It works with the SPA fallback. `log.e2e.ts` and `ReadingCard`
  still use the old URL (BD7/BD8). Old `bv4.back*`/`bv4.tabs.reading_log` keys remain for
  BD8. Check, 406 unit tests and 43 targeted e2e tests (details-shell, log,
  dashboard) pass.

- 2026-11-08 — BD (planning) — Split the book detail page request into
  R1-R13 and eight tasks (BD1-BD8) in three waves. Root cause of the
  inconsistent "‹ Books" button: the reader's Back/close and the metadata
  editor push `/books/{id}`, so the remounted layout treated `/read/…` as the
  previous list and `history.back()` reopened the reader. The Dashboard also
  never recorded a browse context, so the fallback went to a stale list.
  Decisions: an origin stored per tab (child flows excluded); a
  server-authoritative status lifecycle (progress > 0 → Reading, ≥ 99% →
  Read, manual states kept, Re-reading resets progress) with a backfill
  migration; reviews as a new public entity because book-level notes are
  private (the reader creates them). Reference screenshot saved under
  `docs/plans/assets/`. Prompts are Ready.

- 2026-11-08 — HM1 — Replaced text account controls with an icon-only responsive
  header, searchable language picker, local theme toggle and avatar menu.
  Added a dark page-panel palette remap without changing reader routes; failed
  locale persistence keeps the selected language on this device until sign-out
  and displays a one-time notice. No page-specific dark-mode changes were
  needed. Svelte check, all 392 web unit tests, Go lint/tests and the targeted
  browser suite passed (16 passed; one real-server release spec skipped because
  the API backend was not running). The full visual contrast review across the
  listed product pages remains a follow-up.

- 2026-11-08 — BC8 — BC1-BC7 were already integrated in `master`; shared
  tile-lift CSS now serves catalog and Bookheap, the unused `grid` alias is
  removed, and the quick-view placeholder uses the 2:3 token. Adjusted the
  light cloth palettes so author text meets 4.5:1 against the rendered
  texture. Fixed status changes not refreshing dashboard feeds or automatic
  shelves, including a change during an in-flight shelf load. Concurrent
  dashboard row loads now coalesce their cover-state requests with a bounded
  one-second wait; later loads and batches over 100 IDs remain independent.
  Corrected mobile search/upload overlap, kept the Bookheap filter usable at
  narrow widths, and reserved touch space for Info beside the author. A
  real-server suite imports 50 books, covers all eight statuses, batching
  across surfaces, saved-file Play, dashboard movement, contrast, keyboard,
  reduced motion and touch. The rendered contrast check exercises all eight
  actual palettes independently of the IDs assigned to imported books.
  Migration coverage upgrades and rolls back a copied v4 database without
  altering the source. Captured 40 screenshots at 360/768/1440 px and
  reviewed the written requirements; direct comparison with the original
  Images 1-3 remains blocked because those images were unavailable. Full gate
  passed: Go sqlc/lint/test/build, Svelte check 0/0, 382 Vitest cases,
  production build and 180 real-server Playwright cases.

- 2026-11-07 — BC7 — Grid mode in `BookBrowser` (All Books and
  library/author/series/tag pages), the manual shelf and the system shelf
  now use `.book-grid`; list mode is unchanged. The system shelf no longer
  wraps `BookCard` in a second `<li>`. The manual shelf's remove action is a
  full-tile-width `text-xs` trash icon + text button under the cover (list
  mode keeps the underlined link style); it is not cramped at 360 or
  1440 px, so no tile-menu follow-up is needed. The related-books carousel
  uses `gap-5 pt-1 pb-3`, `w-36` tiles and `sm:w-book`, so the hover lift is
  not clipped. Related-books E2E selectors now use the link `title` because
  BC4 renamed cover links to "Open book details". New E2E assertions: 208 px
  (`--spacing-book`) covers at 1440 px on All Books, manual and system
  shelves and related books; a 2-column grid and no overflow at 360 px.
  Svelte check (0/0) and the 14 targeted browser tests passed, run on an
  isolated preview port because BC6 was running concurrently in this checkout.

- 2026-11-07 — BC6 — Dashboard rows now render cover-only `BookCard`s:
  the Continue Reading Resume snippet, `resume()`, its busy/error state and
  the `goto`/`resumeFile` imports are gone; Play on the tile resumes the saved
  file or falls back to the first readable format via `readTarget`. Rows use
  `flex gap-5 pt-1 pb-3`, `w-36` below `sm` and `w-book` (208 px) above, so
  the 4 px lift is not clipped; scroll buttons and the 80% step are unchanged.
  `DashboardRow` no longer takes the unused `account` prop (call site in
  `Dashboard.svelte` updated). Removed `ux5.resume`, `ux5.resuming`,
  `ux5.resume_missing`, `ux5.resume_failed` and `ux5.choose_format` (en/zh);
  `dashboard/resume.ts` is kept for `bookview/read.ts`. The real-server spec
  never used the Resume button, so it needed no change. Svelte check (0/0), dashboard
  Vitest (17) and `dashboard.e2e.ts` (14, incl. new missing-file fallback and
  1440 px width/lift-clipping cases) passed.

- 2026-11-07 — BC4 — Added cover-only grid cards with hover/focus lift,
  localized status badges and progress, persistent touch controls, and
  reduced-motion support. List/search text and optional card actions remain;
  narrow list covers reposition the format badge to avoid the status badge.
  BC6 must remove the dashboard Resume snippet and BC6/BC7 still own sizing.
  BC2's commits were applied uncommitted from `task/bc2` because the current
  checkout lacked the prerequisite. The store now reports failed loads and
  coalesces startup sync with the first request using a bounded wait.
  Badge saves load full state and replay queued mutations before updating, to
  preserve ratings and reading dates. Badge menus escape clipped scrollers
  using the native top layer or a body fallback, superseding BC1's earlier
  no-portal hand-off. Targeted Go and sqlc checks, Svelte check (zero
  diagnostics), 124 Vitest cases, 66 mocked-browser cases and 7 real-server
  cases passed.
- 2026-11-07 — BC5 — Added the default Bookheap grid, persisted Grid/List
  toggle, shared cloth covers for tiles and 48 px list thumbnails, selection
  and heap-status overlays, and reduced-motion-aware hover/focus lift.
  Kept errors and duplicate links for admin triage; both views retain the
  existing row/status/error test hooks. Selection, filtering, paging and bulk
  assign/delete share unchanged logic. Fixed the filter search input's mobile
  overflow and added localized preference-storage error reporting.
  Svelte check (zero errors/warnings), 46 targeted unit tests, production
  build and 16 Bookheap/upload browser tests passed, including exact 208 px
  covers at 1440 px. Final browser validation used an isolated static build
  snapshot to avoid concurrent rebuilds replacing shared preview assets.
  BC8 may consolidate the lift CSS with BC4; no catalog or bookview components
  were changed for BC5.
- 2026-11-07 — BC3 — Added deterministic cloth covers, adaptive grapheme-based
  title sizing, subtitle/series pass-through, image fallback, 2:3 geometry and
  the responsive `.book-grid` contract. The 1440 px baseline measured 158 px
  for dashboard covers and 257.5 px for All Books covers, producing
  `--spacing-book: 13rem` (208 px). Svelte check, 6 cover unit tests, the
  production build, and 10 targeted browser tests passed; the browser report
  contains 1440 px app and six-cover screenshots. BC5-BC7 adopt the shared
  size in Bookheap and page grids.
- 2026-11-07 — BC1 — Done in the current `master` worktree, uncommitted;
  no `task/bc1` branch was created. Migration 00005 preserves existing rows;
  rollback maps `on_hold` and `rereading` to `reading`, and `skimmed` to
  `finished`. Dashboard Read includes `skimmed`, while finished-book
  statistics still count only `finished`. Entering `rereading` starts a new
  reading period and clears the previous finish date.
  Shared BC4 API in `web/src/lib/bookview`: `StatusIcon({ status, class? })`
  renders an aria-hidden status glyph; `statusTone(status)` returns
  `{ text, ring }` Tailwind classes; and
  `ReadStatusMenu({ bookId, userBook, variant: "badge" })` provides the 28px
  status trigger and viewport-flipping/clamped menu. The menu is rendered
  inside its component rather than portalled, so its ancestors must not clip
  it. Targeted sqlc, Go, Svelte, Vitest (107), and bookview Playwright (39,
  plus 4 focused reruns) checks passed; BC8 still owns the full gate.
- 2026-11-07 — BC2 — `task/bc2` (`0090860` API, `b59a35c` store).
  `GET /api/v1/me/book-states?ids=1,2,3` (session auth): 1-100 positive
  canonical integers (the limit counts the raw list), deduplicated, one
  `ReadingListBookStates` query (`json_each` IDs, LEFT JOIN `user_books` and
  `reading_progress` for the viewer, same library-access/`book_hidden` filters
  as the dashboard). Returns `{ items: [{ book_id, status, percentage,
  book_file_id, updated_at }] }` only for books with either row; status is
  passed through from the DB (BC1 values work). Store API for BC4, in
  `web/src/lib/bookview/book-states.svelte.ts`:
  `bookState(bookId): { status: ReadStatus; percentage: number | null; loading: boolean }`
  (a stable reactive object per book and account; safe to call from markup),
  `refreshBookStates(ids?)` (cached IDs only, returns a promise), and
  `getBookStates(ids, signal)` (raw client). Calls in one microtask coalesce
  into one request per 100 IDs (50 covers = 1 request; asserted in the unit
  test, for BC8's E2E). No window-level sync-complete event exists, so the
  store refreshes everything when `offlineStatus.syncing` goes true → false
  without error, plus `online`/visible tab when offline storage is
  unavailable. Unknown statuses map to `unread`; offline it reads IndexedDB
  rows with pending/applied outbox writes replayed via `replayMutations`.
  Checks: `task sqlc:check`, `go test ./internal/reading/... ./internal/httpapi/...`,
  staticcheck on both packages, `pnpm --dir web check` (0/0) and the
  `book-states.test.ts` suite (11 tests) all pass.

- 2026-11-07 — BC plan — Drafted the Book Cover batch (BC1-BC8): cloth-style
  generated covers (Image 1), cover-only tiles with hover lift/Info/Play,
  hover progress bar, top-right status badge with the Image-3 menu, 8 stored
  statuses (migration 00005), batched `/me/book-states`, one `--spacing-book`
  size everywhere incl. a Bookheap grid. Waves: BC1||BC2||BC3, then BC4||BC5,
  then BC6||BC7, then BC8 (the only full verification).

- 2026-11-07 — BV10 — Merged `task/bv1`, `bv2`, `bv4`-`bv9` into `task/bv10`
  (BV3 was already on master). Seams: one shared `ProgressRing` (BV7/BV8),
  one `readStatusLabel`, every consumer imports `BOOK_STATE_CHANGED_EVENT`, the
  legacy Details "Available formats" section is gone, orphan message keys were
  removed and `messages.test.ts` enforces en/zh parity and usage. Added
  `routes/bookview-real.e2e.ts` (real binary: seeded EPUB/PDF/multi-format/CJK
  books, shelves, access, hidden book, sessions, highlights; walks catalog →
  drawer → every tab → reader `?highlight=`, plus restart persistence of the
  summary and sessions). Visual QA at 1440/1024/390 fixed card title clamping,
  Reading Log sessions clipping (sessions now full width below `2xl`) and the
  active tab scrolling out of view on mobile. Gate fixes: `offline.e2e`
  checked a Details string on the Files tab; `covers.e2e` needed `bypassCSP`
  under the real server; the cold-import reader unit test got a 30 s timeout.
  Wrote [book-view.md](../architecture/book-view.md).

  | Gate | Result |
  |---|---|
  | `task sqlc:check lint test build` | Pass (28 Go packages ok) |
  | `pnpm --dir web check` | 0 errors, 0 warnings |
  | `pnpm --dir web test` | 50 files, 358 tests |
  | `pnpm --dir web build` | Pass |
  | `pnpm --dir web test:e2e` (real server) | 143 passed |

  Follow-ups: the importer rejects an EPUB `dc:identifier` of bare
  `urn:uuid:…` without `opf:scheme` (identifier scheme CHECK constraint fails
  the import); `ReadStatusMenu` could take a placement prop instead of BV5's
  CSS override; the `stopped` attempt status is unreachable; an unread file
  shows no "0% read" chip on Files; write-back, progress strips on list cards
  and a stored re-reading status remain out of scope.

- 2026-11-07 — BV9 — Implemented the Highlights tab (`lib/bookview/highlights/`:
  pure `highlights-model.ts` with `buildMarks`, `filterMarks`, `sortMarks`,
  `groupByChapter`, `markStats`, `colorTone`, `matchSegments`; `HighlightItem`,
  `HighlightList`, `HighlightsToolbar`, `HighlightsSidebar`). Data comes from
  `getBookState` (readerState snapshot offline) and refreshes on book-state
  events and window focus. `?q=`/`?sort=` sync with `replace`; compact mode
  persists in localStorage. Notes render only through `renderMarkdown`; search
  marks matches in highlight text only. "Where they came from" is grouped by
  file format. A `pink` tone was added because the reader offers pink. Export
  reuses the notes export for this book. Reader honours `?highlight=<id>` after
  any `?bookmark=` handling; unknown IDs are ignored silently. `task/bv4` was
  merged into `task/bv9` (dependency not yet on master), and the BV4 shell test
  now asserts the real Highlights tab instead of the placeholder. Validation:
  `pnpm check` 0 errors, bookview vitest 57 passed, bookview + reader Playwright
  35 passed (run on a private preview port because 4173 was in use by another
  worktree). Headless Chromium may report "Background Sync is disabled", which
  can surface the reader's generic save banner; the new reader test tolerates it.

- 2026-11-07 — BV8 — Implemented the Reading Log summary, attempts, records,
  timezone-aware chart and filterable, cursor-paginated sessions. Manual add,
  optimistic delete with rollback, CSV export (10,000-session cap), offline
  recovery and book-state refresh are wired up. Manual entries allow backward
  progress but reject future-ending sessions and nonexistent local DST times.
  The progress ring is local markup in `log/LogSummary.svelte`; BV10 should
  consolidate it with BV7's ring if appropriate. No dependency or migration was
  added. Validation: `pnpm check`, production build, 59 bookview unit tests,
  19 mocked Reading Log and tab-shell browser tests, and targeted Go
  reading-log service/HTTP tests passed.

- 2026-11-07 — BV7 — Implemented the responsive Files tab, format-ordered
  reader groups, per-group sorting, selected-file panel, progress ring,
  clipboard actions and English/Chinese copy. Progress follows its file and
  refreshes on book-state events and after synchronization; an offline-loaded
  book refreshes after reconnecting. Unknown formats remain visible in an
  Other group, while cached books from before BV1 use a sanitized fallback
  name and show an unknown added date. Offline removal keeps the legacy
  book-wide semantics and confirmation. **BV10:** `offline.e2e.ts` selectors
  moved to `/books/21/files` and the selected-file actions menu; BV6 still owns
  removal of the legacy Details section. Updated the BV4 shell expectation and
  a BV1/BV3 fixture needed after merging their prerequisites. Validation:
  `pnpm check` (zero diagnostics), 44 book-view unit tests, and 20 Files,
  offline and details-shell browser tests passed; the 390 px overflow check
  passed. Browser tests used an isolated port because 4173 was in use.

- 2026-11-07 — BV6 — Rebuilt Details as a responsive cover/actions column,
  editable reading state and review, reading summary, details/editions panels,
  and related-book carousel. Book-level reviews use synced notes and all edits
  notify other views. Offline Details loads synchronized state and cached cover,
  with edits read-only and network-only sections hidden. Legacy per-file
  read/download/offline actions and inline Add to shelf remain until BV7
  replaces them. No backend or dependency changes. Validation: `pnpm check`,
  57 focused book-view unit tests and 29 mocked browser tests passed.

- 2026-11-07 — BV5 — Implemented the quick-view drawer (`bookview/quickview/`):
  a host mounted once in AppShell (hidden in immersive mode), a right-side
  modal drawer that is full width below `sm` and slides in over 200ms (the
  animation is skipped under reduced motion), Escape/backdrop close, a Tab
  trap, focus restored to the trigger (not after navigation), and stale
  requests aborted when another book replaces the current one. It shows header,
  facts, primary file, tags, collections and synopsis, and the footer has
  Read/Resume, Details, the status menu and an add-to-shelf popover. Admins
  also get an Edit metadata link. It reloads on book-state and shelf change
  events. Decisions and assumptions:
  - Master did not have BV1 yet, so `task/bv1` is merged into `task/bv5`.
  - BV3's `read.test.ts` fixture gained the new BV1 `BookFile` fields.
  - The AddToShelf filter is extracted to `shelves/addable.ts` and shared with
    the popover; AddToShelf behavior is unchanged.
  - The Favorites collection links to `/shelves/system/favorites`.
  - The admin flag comes from AppShell's viewer, so no extra request is made.
  - The kit's ReadStatusMenu is flipped upward with a scoped `:global` CSS
    override. Follow-up: add a `placement` prop to the kit.
  - BV3's `covers.e2e.ts` now presses Escape after Info, because the modal
    drawer covers the grid.
  Validation: `pnpm check` clean; `vitest src/lib/bookview` 40/40; Playwright
  quickview + shell + covers 18/18. Playwright was run against a manually
  started preview, because build + preview exceeds the 60s webServer timeout.

- 2026-11-07 — BV4 — `/books/{id}` is now the `(tabs)` route group (Details,
  Files, Reading Log, Highlights) with a sticky `BookTabs` bar: **‹ Books**
  (history back when the tab area was entered from another in-app page, else
  the browse-context `href` or `/books`), tab links with `aria-current`, and
  `i / n` with Previous/Next buttons plus `[`/`]`. Tab switches and
  previous/next replace the history entry, so Back always returns to the list.
  The old page body moved verbatim into `tabs/DetailsTab.svelte` (offline
  download/remove included); Files/Reading Log/Highlights are "Coming soon"
  placeholders. `/books/{id}/edit` is unchanged and has no tab bar. Browse
  context is remembered by `BookBrowser` (label = page `h1`), the shelf page
  and the system shelf page. **`getBookContext()` returns a `BookContext`
  instance** (`#lib/bookview/book-context.svelte.js`), all fields reactive
  `$state`: `bookId: number | null`, `book: Book | null`, `offline: boolean`,
  `coverSource: string | null` (object URL offline, revoked by the context),
  `coverError: string`, `canEditMetadata: boolean`, `savedFileIds: number[]`
  (writable by tabs after a download/removal), `loading: boolean` (also true
  during a quiet `reload()`, which keeps `book` visible), `error: string`, and
  `reload(): Promise<void>`. The layout renders tab content only when
  `book` is loaded for the current route ID, so tabs may assume
  `context.book` is set. It reloads on `pandalibrary-book-state-changed`
  (matching `detail.bookId`, local constant marked `// BV10`) and
  `pandalibrary-shelves-changed`. Validation: `pnpm check`, vitest
  `src/lib/bookview` (14), Playwright `details-shell` (4), `catalog`,
  `offline`, `metadata` (all pass, no selector changes needed).

- 2026-11-07 — BV2 — Added the per-book reading summary, the filtered and
  paginated sessions list, and the owner-only session delete. Attempts are
  derived by a pure, table-tested function, and days are bucketed in the
  viewer's timezone (tested with Asia/Shanghai across midnight). Stats
  exposes `LoadTimezone`/`LocalMidnight`. Deleting a session does not bump the
  sync revision. Added the typed client `web/src/lib/bookview/log-api.ts`;
  its delete tolerates the 204 without editing the shared client. Contract
  clarifications are recorded in the plan: UTC default timezone, active-day
  definition, pace denominator, null records, and the unreachable `stopped`
  status. No migration.

- 2026-11-07 — BV1 — Book `files[]` items now carry `original_filename` and
  `created_at` (all `Book` producers share `hydrateBook`). The name is a base
  name: `\` normalized to `/`, drive prefix and directories stripped, control
  characters replaced with `_`; empty/unusable names fall back to
  `<title>.<format>`. Added `GET /api/v1/books/{id}/shelves` (manual shelves
  only, `/shelves` visibility and counts, name/ID order, cap 200, 404 for an
  invisible book) via the new `ShelfListContainingBook` query; no migration.
  Web: `BookFile` fields, `getBookShelves`, and updated type-checked fixtures
  (e2e route mocks untouched). Contract deviation: none beyond the control
  character replacement.

- 2026-11-07 — BV3 — Implemented deterministic, contrast-checked title covers,
  format badges, hover/focus/touch actions, the shared interactive kit, and
  English/Chinese copy. Info dispatches the quick-view event; the drawer remains
  BV5. `readTarget` resumes saved progress, falls back only when that file is
  unavailable, and propagates other failures. `isUserBook` narrows the existing
  `BookState.user_book: unknown` before it is passed to the kit. The existing
  reader mutation entity type was widened to include the server-supported
  `user_books` upsert. `formatSize` is available in the kit; the old book page
  retains its local copy until BV4/BV6 replace it, because that route is outside
  BV3 ownership. No migration or dependency was added.
  Final component props for BV5-BV9:
  - `Icon`: `name: IconName`, `class?: string`.
  - `BookCover`: `id`, `title`, `authors?: readonly string[]`,
    `coverUrl?: string | null`, `files?: readonly BookFile[]`,
    `size?: 'sm' | 'md' | 'lg'`, `badge?: boolean`, `class?: string`,
    `loading?: 'lazy' | 'eager'`.
  - `FormatBadge`: `files: readonly BookFile[]`, `size?: 'xs' | 'sm'`.
  - `CoverActions`: `book: Book | SearchResult`,
    `variant: 'grid' | 'list' | 'search'`; search emits only the book ID.
  - `RatingStars`: `value: number | null`, `size?: 'sm' | 'md' | 'lg'`,
    `editable?: boolean`, `onChange?: (value: number | null) => void`;
    `onChange` is required when `editable` is true.
  - `ExpandableText`: `text: string`, `lines?: number`.
  - `IdentifierLinks`: `identifiers: readonly Identifier[]`,
    `variant?: 'icons' | 'chips'`.
  - `ReadStatusMenu`: `bookId: number`, `userBook: UserBook | null`,
    `reread?: boolean`, `variant?: 'pill' | 'icon'`.
  `pnpm --dir web check` passed with no diagnostics; 33 focused unit tests and
  23 mocked cover/catalog/dashboard/search/shelf browser tests passed.

- 2026-11-07 — BV plan — Drafted the Book View batch (BV1-BV10): client-side
  generated title covers with a format badge, hover Info/Read actions, a
  right-side quick view drawer, and a tabbed `/books/{id}` (Details, Files,
  Reading Log, Highlights) in a `(tabs)` route group. No migration: two
  additive catalog changes (BV1) and a per-book reading summary/sessions/delete
  API with derived attempts (BV2). Waves: BV1||BV2||BV3||BV4, then
  BV5||BV6||BV7||BV8||BV9, then BV10 (the only full verification).

- 2026-11-06 — BH5 verification — Added real-server PDF/CBZ scan coverage and
  a deterministic concurrent-scan assertion. The restart check now crashes
  the server only after observing an active job and verifies that a pending
  or processing job remains on disk before restarting. Fixed a drop-folder
  test race by waiting for all source-file cleanup before checking archives.
  The focused Bookheap browser suites passed 12 tests and clean up their own
  fixtures. The restart check passed on Windows and Linux, and the Linux scan
  tests exercised symlink rejection.

- 2026-11-06 — BH5 — Integration gate. Added the real-server suite
  `bookheap.e2e.ts` (6 tests: header upload, scan, assign across pages to a
  library and shelf, delete, reader denial, drop folder) and
  `web/scripts/bookheap-restart-check.mjs` (stops the server during a
  150-item assignment and verifies consistency after restart; also in CI).
  Fixed an importer deadlock: hook lookup took the importer mutex inside the
  writer transaction while enqueue held it waiting for the writer. Hooks now
  use `hooksMu`, with regression test `TestAssignWhileImporterRuns`. Also
  fixed the "Bookheap" import-source label and existing E2E locators that
  BH3's header Upload made ambiguous, and aligned the footer-version test
  with master's compact version. Gates pass: Go, web 252 unit tests,
  E2E 74/74, and a Podman image build (Docker unavailable).
  Follow-up (high): EPUB/FB2/MOBI imports with an unknown identifier scheme
  fail the `book_identifiers` CHECK for every source.

- 2026-11-06 — BH2 — Added `POST /api/v1/admin/bookheap/assign`: whole-request
  library/shelf validation (manual, writable, not another user's private
  shelf; Favorites allowed), then per item a same-file check, `importer.Stage`
  copy and a `bookheap` import job queued in the same transaction that marks
  the item `queued`. A narrow `importer.Hook` (Started / Imported in the book
  transaction / Finished / Recover) adds books to still-writable shelves,
  deletes the row, removes the unchanged heap file after commit, and records
  duplicates/failures (files kept, retryable). Startup reconciles
  queued/importing rows. Catalog exports `CheckAssignableShelf` and
  `AddAssignedBookTx`. Per-item codes add `changed`/`failed`. Upload/drop
  importer tests unchanged; `task sqlc:check lint test build` passes.

- 2026-11-06 — BH4 — Added the admin-only `/bookheap` page and HOME entry
  (after All Books, with a ready-count badge): Scan with live progress and
  summary, Upload via BH3's dialog, URL-synced status filter and debounced
  search, Load more paging with totals, rows with cover/metadata/status/reason
  and duplicate links, cross-page selection (500 cap), bulk Assign (library +
  writable manual shelves, skips non-assignable items) and confirmed Delete
  with per-item results, and bounded polling while items are queued/importing.
  Assign is mocked against the plan contract until BH2 merges. BH1 filters a
  single status, so Queued/Importing is merged client-side. Check, unit tests,
  build and the mocked browser suite pass.

- 2026-11-06 — BH1 — Added `PANDA_BOOKHEAP_DIR` (default `<data>/bookheap`,
  overlap-validated), migration 00004 (`bookheap_items`, `import_jobs.source`
  accepts `bookheap`), the `internal/bookheap` service (streamed upload with
  duplicate/sniff checks and collision-free naming, list/get/cover, bulk delete,
  background scan with settle/depth/entry limits) and admin-only endpoints.
  Maintenance guards the heap folder and keeps heap covers. Delete reports
  `changed`/`failed` besides `busy`/`not_found`; scan state is in memory.
  vet, staticcheck, sqlc diff, tests and build pass.
- 2026-11-06 — BH3 — Added the admin-only header Upload button and the
  multi-file Bookheap upload dialog (drop zone, Select files, Clear, per-row
  remove, dedupe by name/size/mtime, extension and 1 GiB pre-filters, XHR
  uploads two at a time with progress, localized 409/413/415/401/403/network
  results, Retry failed, View Bookheap, confirmed abort on close). One shared
  queue (`uploadQueue`) keeps non-done rows until reload, so BH4 can reuse it.
  Mocked against the plan contract only; BH5 must verify against BH1's real
  endpoint. Check, unit tests, build and the bookheap/shell browser tests pass.

- 2026-11-06 — BH plan — Drafted the bookheap follow-up (BH1-BH5): header
  Upload dialog, admin-only staging folder (`PANDA_BOOKHEAP_DIR`, default
  `<data>/bookheap`) indexed in `bookheap_items`, background Scan, and bulk
  assignment through the importer (library required, shelves optional).
  Waves: BH1||BH3, then BH2||BH4, then BH5.

- 2026-11-05 — UX6/UX8/UX10 — Completed saved-position validation/pagination,
  exact PDF/CFI jumps, durable account-isolated bookmark sync, admin account
  lifecycle/self-session retirement and paged identity selectors. Integrated
  footer/live shelves/native shelf dialog; replaced dashboard's unbounded
  pagination with SQL keysets. All 58 real-server browser tests, 204 frontend
  units, frontend check/build, SQL generation and Go build/lint/tests pass.
  V1 upgrade retains users, library, shelf membership, annotations, notes,
  reader settings and file bytes. Actual Podman scratch image is 11.4 MiB;
  provenance, health, shutdown, migrations and account/session/library restart
  persistence pass. Browser screenshots cover both actual locales and responsive
  layouts. Fixed stale test selectors/setup isolation, bounded browser actions,
  sequenced embed builds, and LF container exclusions for generated assets.
  Exact commands and first-release baseline limitations are in UX10.

- 2026-11-04 — UX5 — Finished on `master`: minimal cross-task fixes (admin user
  form submit/validation, shelf dialog focus return, bookmark typing/i18n,
  `bookmarks` in sync and dashboard mocks) make `pnpm --dir web check` pass
  with 0 errors and 0 warnings. 195 unit tests, the build, and the dashboard
  browser tests pass. Four existing shell/offline browser failures from other
  tasks remain; see the UX5 prompt.

- 2026-11-04 — UX5 — Implemented configurable, independently paged dashboard
  cover rows, reusable shelf creation, safe resume, and account-scoped durable
  layout sync, including explicit empty/corrupt/offline/conflict states.
  Frontend build, 189 unit tests, 12 dashboard browser tests (including the
  real server and offline cross-device sync), and an isolated dashboard
  Svelte check pass. The full frontend check remains blocked by 11 pre-existing
  errors and 6 warnings in admin and the shared UX3 shelf dialog; see the UX5
  prompt for commands and details.

- 2026-11-04 — UX4 — Implemented account-scoped dashboard book feeds API with
  `GET /api/v1/dashboard/sections/{section}/books` for `continue_reading`, `recently_added`,
  `read`, `unread`, `want_to_read` sections. Added five SQL queries in `dashboard.sql`
  filtering by exact predicates and timestamps with ID tie-breakers. Service implements
  keyset pagination with opaque cursors scoped to viewer+section. HTTP handler with
  session auth, visibility checks (library grants, hide lists, requester-scoped reading data).
  All queries filter/page in SQL before hydration; no per-book calls or enumeration.
  Returns existing `Page<Book>` contract unchanged. Default limit 20, max 100 with validation.
  Added comprehensive test suite: multiple accounts/libraries, hidden books, library access,
  section predicates/ordering, pagination, invalid inputs. sqlc generation, Go build/lint/test,
  full catalog/httpapi suites pass. Hand-off docs with DTO/route/ordering/cursor examples
  in `docs/ux4-handoff.md` ready for UX5. No migrations, model changes, or refactors.

- 2026-11-04 — UX1 — Added the dark header + left sidebar shell (`web/src/lib/shell/`),
  All Books at `/books`, the library index at `/libraries`, and a temporary dashboard
  at `/` (UX5 replaces it). Below `lg` the sidebar is a focus-trapped drawer; the reader
  route is immersive. Shelves slot (`data-slot="sidebar-shelves"`) awaits UX3; footer
  slot (`data-slot="sidebar-footer"`) awaits UX10 wiring of UX9's `BuildVersion`.
  `/bookmarks` links ahead of UX6. Also fixed filter selects that ignored deep-linked
  values. check, unit, build and the full real-server Playwright suite pass. Status Review.

- 2026-11-04 — UX2 — Added migration 00002 (`mode`, `system_key`, `rules`) with
  Favorites backfill and lazy, idempotent provisioning. Added the GET-only
  `/api/v1/shelves/system/{favorites|unshelved}` routes and private automatic shelves
  with flat all/any rules. The rules are evaluated live in SQL with the existing
  visibility predicate. Mode conversion, system-shelf rename and delete, and automatic
  membership writes return 409; shelf-list cursors issued before UX2 are invalidated.
  `task sqlc:check`, `task build`, `task lint` and `task test` pass. Details are in
  the UX2 hand-off and `architecture/ux2-shelves.md`.

- 2026-11-04 — UX9 — Added validated UTC commit provenance to the CLI and public
  version API, ordinary builds and fresh/cached `go run`, plus portable stamped
  release/image wrappers. Added the standalone bilingual, accessible version
  footer for UX10 to wire. Go lint/tests, frontend check/tests/build, Chromium
  footer tests, shallow/dirty fixtures, Vite proxy, tagged cross-build, and
  scratch container checks pass; unstamped raw image builds fail explicitly.
  Exact commands, API/component contracts, and image results are in the UX9 hand-off.

- 2026-11-04 — UX7 — Implemented session/admin-only account CRUD, username/ID
  keyset paging, strict bounded JSON, transactional self/last-enabled-admin
  protection and acting-session rechecks. Reset/disable/revoke invalidate browser
  and OPDS/KOReader credentials; role changes revoke browser sessions; deletion
  preserves shared catalog data. Shared CLI reset now also revokes app passwords;
  login rechecks prevent in-flight old-password sessions after reset. Focused
  auth/HTTP/app/CLI/OPDS/KOReader tests, sqlc diff, CGO-free build, vet,
  staticcheck, full Go tests and ten repeated concurrency runs pass. Exact UX8
  API/error examples and self-reset/revoke login redirect are in the UX7 hand-off.
  No migration, dependency or web changes.

- 2026-11-04 — UX planning — Committed existing work as `05326ce`; extraction
  tests, reader units and frontend checks passed. Ignored local dev launchers.
  Assessed the screenshot request and prepared ten Ready issue prompts with
  fixed ownership, API/component contracts and four execution waves. No feature
  implementation or remote issue creation was performed.

- 2026-11-04 — X1/X3 — Revalidated the existing BOM/Windows-1251 shared-sniffer fix
  and both formerly skipped registry cases. Closed malformed-root gaps and added
  exact source-byte probe-limit regression coverage. Focused extraction tests and
  `task build`, `task lint`, `task test` pass; X1/X3 remain Done and X3 unblocked.
  Details are in the X1/X3 prompt hand-offs; the FB2 extractor is unchanged.

- 2026-11-04 — X1/F2/X3 — Fixed shared plain-FB2 sniffing for UTF-8 BOM and declared
  Windows-1251 encodings, kept XML root probing bounded, and configured the XML decoder
  with `charset.NewReaderLabel`. Removed the X3 test skips and extended importer registry
  coverage for both encodings. `go test ./internal/extract/...`,
  `go test ./internal/importer -run TestEveryDispatchableFormatUsesImporterRegistry`,
  `task sqlc:check build lint test` pass. Closed the stale F2/X1 review labels and marked
  X3 done. Remote CI/release workflows could not be triggered because this checkout has
  no Git remote; KOReader device validation remains unavailable without a device.

- 2026-11-04 — Q1 — Completed local release validation. The scratch image measures
  11.3 MiB as a gzipped image archive (below the 35 MiB ceiling); Podman Docker-format
  builds preserve its healthcheck. Verified non-root persistent storage, startup
  migrations, setup reachability, healthy/unavailable checks, and clean SIGTERM exit.
  Replaced the Windows-hanging E2E process wrapper with Playwright-owned setup/teardown,
  isolated loopback ports/data, redacted diagnostics, and verified cleanup on startup
  failure and success. All 39 compiled-server browser tests pass; static-preview mode
  retains 38 passing tests and skips the real-server-only journey. Go build/lint/test,
  web check/build and 161 unit tests pass. The first-release upgrade fixture now comes
  directly from the immutable v1 migration rather than candidate startup; both upgrade
  paths pass locally (the previous-binary branch used the same local build). CI and
  release workflows fetch a prior release when available; remote workflows have not
  been executed in this session. Existing FB2 and KOReader-device caveats remain.

- 2026-11-04 — Q1 — Added the scratch multi-stage container, versioned release binaries,
  least-privilege published-release workflow, full real-server Playwright harness, v1
  baseline/previous-release upgrade check, and user/operator guide. `task build`, `task
  lint`, `task test`, web check/test/build, all 39 Playwright tests, and the generated
  upgrade baseline pass. Local container build could not fetch Docker Hub layers through
  Podman; CI now measures compressed size and verifies runtime/health/shutdown behavior.
  Awaiting the CI container gate.

- 2026-11-04 — docs — Drafted the Step 11 Q1 release and end-to-end prompt from the
  accepted plan, deployment/migration architecture, current CI and browser-test setup, and
  the merged feature status. It covers the scratch image and healthcheck, real-server
  Playwright CI, a first-release-safe migration-upgrade baseline, release workflow, and
  operator guide. Awaiting review.

- 2026-11-04 — W5 — Added the administrator-only `/admin` area: library CRUD with
  conflict messages, per-library access grants, per-user hide lists, single-file uploads
  with cursor-paged import history that polls (bounded, non-overlapping) while jobs are
  active, metadata provider settings with write-only tokens (omit preserves, `null`
  removes after confirmation), and maintenance jobs with run-now, 409 handling, and an
  in-memory-status notice. Admin nav is role-filtered and the layout re-checks the role.
  Follow-ups: no user-list/account API exists, so grants and hide lists use numeric user
  IDs from the CLI; hide lists lack book titles. 29 unit and 7 browser tests.

- 2026-11-04 — W6 — Added the admin-only `/books/{id}/edit` page (with an "Edit metadata" link on
  the book page for admins): bodyless M1 lookup, per-field radios defaulting to "keep current",
  apply sends only `{provider, reference}` under the current `request_key`, 409 clears
  selections and re-runs the lookup, cover options only when the candidate has `cover_url`, and
  previews only through the server preview endpoint (object URLs revoked). No manual PATCH
  editing is offered. The PDF cover batch lives on the edit page (route ownership is limited to
  `books/[id]/edit`). It walks visible libraries and books with opaque cursors (repeated-cursor
  guard), runs one book at a time, and rechecks each book before download and again before
  upload. A small race remains because `PUT ?source=pdfjs` overwrites existing covers. It
  renders page 1 with pdf.js to a JPEG (long edge 1200 px, scale ≤ 4, quality 0.85; PDFs over
  256 MiB are reported as too large). Cancel stops after the current book. 20 unit and 3
  browser tests.
- 2026-11-04 — W7 — Added `/stats` over ST1 (local inclusive dates, browser IANA timezone,
  366-day guard, inline SVG bar charts with data tables; no chart dependency) and `/notes`
  over R1/E1 (URL-driven annotation search, "Book {id}" labels since results lack titles,
  positions for highlights only, per-book export selection capped at 100 and reset per
  query, Markdown/ZIP download via Content-Disposition filenames). 39 unit and 4 browser tests.

- 2026-11-04 — docs — Drafted the Step 10 W5–W7 prompts from the merged APIs and UI
  hand-offs. W5 records the missing administrator user-list/account-management API and
  limits its user access controls to explicit IDs; all three prompts await review.

- 2026-11-03 — W4 — Added the app-shell search box and `/search` page over S1 (query in
  the URL, cursors passed back verbatim, pagination reset on query change, 400s treated
  as a restart prompt), plus `/shelves` and `/shelves/{id}` over SH1: listing, private
  creation (shared only offered to admins), rename/description editing with explicit
  null clearing, confirmed deletion that keeps books, search-to-add and remove members,
  and stale-cursor restart. Book detail gains "Add to shelf"; W1's `BookCard` gains an
  optional `actions` snippet. The library books API has no shelf filter, so the library
  page links to shelf pages instead of client-filtering. A shared rune-based
  `CursorPager` drops superseded responses and never duplicates a pending request.
  `pnpm --dir web check`, `test` (73), `build`, and `test:e2e --workers=2` (24) pass.

- 2026-11-03 — E1 — Implemented authenticated `GET /api/v1/me/notes/export` for 1–100
  distinct visible books. Single-book Markdown and multi-book ZIP exports include safe
  Obsidian frontmatter, ordered live annotations, no-store attachment headers, and
  collision-safe cross-platform filenames. Batched read-only sqlc queries enforce user
  ownership and visibility; response generation is bounded. Golden, ZIP, HTTP, and app
  mount tests pass; `task sqlc:check`, `task build`, `task lint`, and `task test` pass.

- 2026-11-03 — O1 — Implemented the `/opds` OPDS 1.2 catalog: HTTP Basic with OPDS app
  passwords only (rate-limited failures, 401 challenge), navigation feeds for libraries,
  authors, series, tags and shelves, acquisition feeds for recent, search, each entity,
  shelves, reading and want-to-read, an OpenSearch description, and authorized
  download/cover routes. Feeds reuse catalog/search/shelf services and opaque cursors
  (50 per page, `rel=next`); status lists use a viewer-bound keyset query. Links come
  only from the trusted base URL. No Java/Python RELAX NG tool was available, so tests
  check every feed against a Go port of the official `opds.rnc` rules; feeds also parse
  in Thorium's `r2-opds-js` 1.0.47. KOReader manual check remains a follow-up.
  `task build`, `task lint`, and `task test` pass; no migration.

- 2026-11-03 — ST1 — Implemented authenticated `GET /api/v1/stats` with bundled IANA
  timezone data, inclusive zero-filled daily/monthly buckets, current-status finished
  counts, all-history positive-day streaks, and deterministically ordered per-book
  totals/authors. All aggregates use current access-plus-hide rules, including admins,
  and a consistent reader transaction; SQL aggregates sessions without loading raw
  history. Enforced strict parameters, 366 dates, 1000 books, and bounded query work.
  Real-SQLite and HTTP regressions cover DST, midnight gaps/overlaps, skipped dates,
  fractional/historical offsets, leap-year intervals, visibility, limits and failures.
  `task sqlc:check`, `task build`, `task lint`, and `task test` pass. W7's stable DTO
  and error/limit contracts are recorded in the ST1 prompt; no migration or reader
  behavior changes.

- 2026-11-03 — docs — Drafted Step 9 prompts ST1, E1, O1, and W4 from the accepted plan,
  current architecture, and merged R1/S1/SH1/W1 contracts. Prompts await review.

- 2026-11-03 — M1 review — Restricted the NeoDB private-address exception to the exact
  request origin on every hop. Added regression tests for direct and redirected requests
  that change scheme while retaining the same host and port.

- 2026-11-03 — W3 — Completed the offline PWA with explicit hash-versioned file/cover
  downloads, account-scoped IndexedDB, durable progress/annotation/settings/session outbox,
  bounded R1 push batches and atomic pull/cursor persistence. Confirmed edits survive a
  failed pull without a duplicate push; stale/rejected writes remain reviewable. Added
  app/online/visible/reader/Background Sync triggers, explicit retry, trusted-device
  offline session restoration and logout/account isolation, 403/404 eviction, bilingual
  accessible storage/persistence/quota controls, and a public-shell-only service worker.
  Private files and metadata share an IndexedDB transaction rather than a second
  unscoped Cache Storage cache; online files bypass HTTP caches for access revalidation.
  `pnpm --dir web check`, `test` (53 tests), `build`, and `test:e2e -- --workers=2`
  (21 tests) pass. Browser tests prove offline progress/notes survive reload, reconnect
  pushes then pulls without Background Sync, denied books/files are evicted, and account
  changes/logout isolate downloads. Browser/API limits and the 180-day full-resync
  decision are recorded in the W3 prompt; backend behavior and schemas are unchanged.

- 2026-11-03 — M1 — Implemented Open Library, Google Books, NeoDB, and Hardcover
  adapters against verified official contracts, parallel ISBN-first lookup with bounded
  time/rate and versioned SQLite caching, write-only admin credentials, and cached
  per-field selection APIs. Catalog integration commits selected values, cover
  reference, provenance, and FTS atomically without changing manual edit behavior.
  Cover downloads enforce provider host allowlists, redirect/DNS/IP checks, exact-origin
  explicit NeoDB exceptions, and image/time/size limits. Offline fixtures and HTTP/TLS
  tests cover success/failure, cache, secrets, visibility, apply rollback, and cover
  safety. `task sqlc:check`, `task build`, `task lint`, and `task test` pass. The M1 prompt
  records W5/W6 DTOs, limits, and upstream limitations; no migration or UI changes.

- 2026-11-03 — K1 — Re-ran full gates after concurrent M1/J1 changes settled:
  `task sqlc:check`, `task build`, `task lint`, `task test`, and uncached
  K1/HTTP/reading/app tests pass. K1 marked Done; real-device XPointer validation remains
  a follow-up (chapter synthesis stays disabled behind `Options.ChapterXPointer`).

- 2026-11-03 — K1 — Implemented all five `/kosync` endpoints, existing app-password
  verification with bounded failure throttling, exact per-user raw records, visibility-
  checked R1 LWW/revision bridging, and atomic server-derived sessions. Added golden HTTP,
  application-mount and migrated-SQLite tests for credentials, field limits, all seven
  formats, visibility, freshness, page/chapter mapping, session boundaries/restarts,
  stale writes and rollback. Uncached K1/HTTP/reading/app tests and scoped staticcheck
  pass; adapter statement coverage is 84.1%. `task sqlc:check` and `task build` pass.
  The full test suite passed once, but final lint/test encountered concurrent M1's
  test-file syntax error; unrelated implementations were not changed. No real KOReader
  device/model was available: chapter-XPointer synthesis is tested but disabled in
  application wiring. Newer web positions retain the last device XPointer with web
  percentage/time; without one, return no position. Exact PDF/CBZ pages remain enabled.
  Setup and the unhyphenated app-password requirement are documented in the root README
  and K1 hand-off.

- 2026-11-03 — J1 — Implemented bounded hourly expiry/tombstone/history cleanup, verified
  online backups with seven-snapshot retention, conservative 24-hour-grace book/cover
  orphan cleanup, daily optimize/FTS checks, and passive five-minute checkpoints.
  Admin status/manual-run routes share per-job exclusion with scheduled runs; shutdown
  cancels accepted work before database close. Active imports, spool manifests, the import
  ID high-water row, symlinks, referenced/recent files, and custom drop roots are preserved.
  A shared storage publication guard restarts republished covers' grace periods and
  prevents orphan-removal races. Focused blobstore/jobs/HTTP/application tests, five
  repeated storage/job runs, targeted vet/staticcheck, `task sqlc:check`, `task build`,
  `task lint`, and `task test` pass. Two dedicated symlink tests skip on this Windows host
  because symlink privileges are unavailable. J1 prompt and architecture record schedules,
  safe-retention exceptions, bounds, and the W5 route/DTO contract.

- 2026-11-03 — docs — Drafted all four Step 8 prompts (W3, K1, M1, J1) from the accepted
  plan, current architecture/schema, and merged W2/R1/I1/C1/X1 interfaces. Prompts define
  shared app/router append-only wiring; K1 records the real-device test or safe fallback
  requirement. Awaiting review.

- 2026-11-03 — W2 — Implemented the seven-format browser reader and reader-owned chooser,
  accessible English/Chinese controls, R1 progress restore/debounced saves, highlights,
  sanitized CodeMirror Markdown notes, settings, and active reading sessions with explicit
  retry. Foliate sections are sanitized and receive a script-denying CSP; direct Blob
  capture avoids weakening the host CSP for intermediate blob fetches. PDF.js assets are
  bundled same-origin. `pnpm --dir web check`, `test` (30 tests), `build`, and the full
  Playwright suite (16 tests, isolated port 4193) pass. Generated fixtures exercise all
  seven formats including genuine KF8/AZW3; the malicious EPUB covers inline/external
  same-origin scripts and event handlers. No offline/PWA work was added; W3 constraints
  and in-memory-only retry behavior are recorded in the W2 prompt.

- 2026-11-03 — I1 — Implemented streaming administrator uploads, add-format and bounded
  job history; safe content-addressed book writes with one-pass SHA-256/KOReader hashes;
  two durable SQLite-backed workers, transactional catalog/FTS writes, concurrent dedupe,
  cover publication, restart manifests, and graceful cancellation. Added fsnotify startup
  and live scans, three-second stability checks, per-library drop routing, optional
  `PANDA_DROP_POLL`, and safe duplicate/failure outcomes. `task sqlc:check`, `task build`,
  `task lint`, and `task test` pass. API/lifecycle and J1 spool-retention contracts are in
  the I1 prompt. X1/X3 Windows-1251 and BOM plain-FB2 sniffing remains an explicit
  follow-up; extractor/sniffer code and migrations were not changed.

- 2026-11-03 — S1 — Implemented visibility-filtered trigram and short-query book search,
  deterministic ranked pagination, and an authenticated API. Added SQLite, catalog
  visibility, application-mount and HTTP tests; `task sqlc:check`, `task build`,
  `task lint`, and `task test` pass. The prompt records the W4/O1 result and cursor contract.
- 2026-11-03 — SH1 — Implemented private/shared shelves, transactional manual ordering and
  viewer-filtered counts and book pagination. Added authorization, visibility, concurrency,
  rollback, and HTTP tests; `task sqlc:check`, `task build`, `task lint`, and `task test`
  pass. No migration was needed; the prompt records the O1/W4 response and cursor contract.
- 2026-11-03 — docs — Drafted the Step 7 prompts (W2, I1, S1, SH1) from the accepted plan,
  current architecture, and merged R1/C1/extractor interfaces. I1 explicitly records the
  known X3 plain-FB2 sniffing blocker; prompts await review.
- 2026-11-03 — X3 — Implemented MOBI/AZW3 and FB2/FBZ extractors with DRM detection,
  bounded metadata/covers, generated fixtures, and registration tests. `task build`,
  `task lint`, and `task test` pass. Plain FB2 registry dispatch for Windows-1251 and
  UTF-8 with a BOM is blocked by X1's out-of-scope sniffer; direct extraction and FBZ
  dispatch work, and two registry cases are explicitly skipped pending an X1 fix.
- 2026-11-03 — W1 — Implemented the bilingual catalog UI with accessible library browsing,
  entity indexes/details, URL-backed book filters and sort, server-cursor paging, book
  details and hash-versioned downloads. `pnpm --dir web check`, `test`, `build`, and the
  full Playwright suite pass; browser validation used port 4193 because 4173 was occupied.
- 2026-11-03 — R1 — Implemented the user-scoped reading/settings APIs, transactional LWW
  push/pull, append-only sessions, annotation tombstones/FTS, and visibility-filtered search.
  Added SQLite service and authenticated HTTP tests; `task sqlc:check`, `task build`,
  `task lint`, and `task test` pass. No migration was needed.
- 2026-11-03 — X2 — Implemented bounded PDF metadata/page-count extraction with pdfcpu
  v0.16.4 and ComicInfo/cover extraction for CBZ; added generated-fixture, error, and
  registry tests. `task build`, `task lint`, and `task test` pass. I1 can register with
  `pdf.Register` and `cbz.Register`; no global registry wiring was added.
- 2026-11-03 — docs — Drafted all four Step 6 prompts (R1, W1, X2, X3) from the accepted
  plan and the current C1, X1, database, extractor, and web interfaces. Prompts are ready
  for review; implementation remains gated on review/merge of the prior work.
- 2026-11-03 — C1 — Implemented the visibility-filtered catalog, library ACLs, metadata
  and FTS transactions, and authorized file/cover serving. `task sqlc:check`, `task
  build`, `task lint`, and time-bounded `task test` pass; F2/X1 remain in review.
- 2026-11-03 — C1 — Started implementing the catalog core in the current `master`
  worktree at the user's request.
- 2026-11-02 — C1 — Drafted the catalog-core prompt from the accepted plan and merged
  auth, server, database, and cover interfaces. Awaiting review; implementation has not
  started.
- 2026-11-02 — A1 — Started implementing the authentication vertical slice on `master`.
- 2026-11-02 — A1 — Implemented the authentication vertical slice: setup, sessions,
  profile and app-password APIs, secure user CLI commands, and bilingual web flows.
  Go tests/build, sqlc checks, web checks/tests/build, lint, and isolated Playwright
  setup/login/app-password flows pass.
- 2026-11-02 — A1 — Drafted the authentication vertical-slice prompt from the accepted
  plan and the merged F4/F3/F2 interfaces. Prompt is ready for review; implementation has
  not started.
- 2026-11-02 — F4 — Implemented configuration, migration-gated startup, the chi router,
  healthcheck, embedded SPA, trusted-proxy/security middleware, and scheduler lifecycle.
  The SPA fallback needs an inline SvelteKit bootstrap, so the server uses an HTML
  tokenizer and a fresh CSP nonce per response; the architecture now records this.
  `task web:build`, `task build`, `task lint`, `task test`, and `task sqlc:check` pass;
  focused Linux race tests and live CLI/browser checks pass. A1 can add `httpapi.Mount`
  callbacks, apply the supplied cookie-protection middleware, and use the resolved
  client IP/scheme helpers; app wiring owns startup and shutdown.
- 2026-11-02 — F4 — Started on `master` at the user's request. The existing Go lint and
  test tasks pass with the F3 web assets built.
- 2026-11-02 — F4 — Drafted the server-skeleton prompt from the accepted plan and the
  current F2/F3 interfaces. Implementation remains gated on step 2 being fully merged.
- 2026-11-02 — F1 — Merged `task/f1` into master after F2, F3 and X1 had landed with
  their own minimal Go plumbing. Kept the F2 CLI (real `migrate` commands) and tests,
  module requirements, and the F3 CI web steps; added F1's package docs, editor/ignore
  rules, Task descriptions with the inline CGO override, and pinned tool versions.
- 2026-11-02 — F3 — Added the SvelteKit SPA scaffold, Tailwind/shadcn setup, English and
  Chinese Paraglide messages, typed API client/navigation foundation, Playwright config,
  Vitest coverage, and Go embed package. Frontend check/test/build and `go test ./...`
  pass; CI builds web assets in each independent job. The generated fallback is ready for
  F4 to serve on client-side routes.
- 2026-11-02 — F1 — Completed the Go 1.27 scaffold with explicit failing CLI stubs,
  subprocess dispatch/exit tests, documented internal packages, portable Task targets,
  baseline editor/ignore settings, and Go-only CI with pinned Task/staticcheck tools.
  `task build`, `task lint`, and `task test` passed on Windows and Linux; actionlint
  passed. The hosted workflow awaits a push (no remote configured). No runtime
  dependencies, migration changes, web files, or design changes were introduced.
  F2/F3/F4 retain ownership of database, web, and server implementation; merge F1
  before starting step 2.
- 2026-11-02 — F1 — Started the repository scaffold on `task/f1`.
- 2026-11-02 — F1 — Prompt drafted; awaiting review before starting the scaffold.
- 2026-11-02 — F2 — Implemented the SQLite writer/reader pools, migration runner, checksum
  verification, sqlc generation, operator commands, and migration tests. `task build`,
  `task sqlc`, `task sqlc:check`, F2-local tests, vet, and staticcheck pass. Full `task
  lint` and `task test` are blocked by the concurrently added `web/embed.go` requiring
  missing `web/build` assets. F1 was not present on master, so minimal Go/module/task/CLI
  plumbing was added as a prerequisite; F1 remains incomplete.
- 2026-11-02 — X1 — Implemented shared extraction types, safe ZIP sniffing/limits,
  timeout-and-recover registry, EPUB2/3 metadata and cover extraction, JPEG cover
  normalization, and KOReader partial MD5. `task build` and `task test` pass; X1-local
  vet/staticcheck pass. Repository `task lint` reports unrelated `internal/db/migrations/`
  diagnostics, so X1 is marked Review pending that shared validation.
- 2026-11-02 — docs — Drafted Step 2 prompts for F2, F3, and X1 from the accepted plan
  and architecture. Review and reconcile each against the merged F1 scaffold before
  starting those tasks.
- 2026-11-02 — docs — Open questions settled (all recommendations accepted). ADR-0001, 0003
  and 0004 accepted. Plan reorganised into 11 numbered steps of at most 4 parallel
  sessions; the gates F1, F4, A1, C1 and Q1 each run alone. X2/X3 run in step 6 so all
  formats exist before the reader UI (W2). Next: write the F1 prompt.

- 2026-11-02 — docs — Design complete. Schema moved to
  `internal/db/migrations/00001_init.sql`; docs restructured into architecture, decisions,
  plans, prompts and progress; v1 plan written. No code yet.
