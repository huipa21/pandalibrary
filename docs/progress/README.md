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
| 1 | BV1 | Catalog API: file name/added, shelves containing a book | baseline | [BV1](../prompts/BV1-catalog-detail-api.md) | Ready | `task/bv1` | |
| 1 | BV2 | Per-book reading log API + web client | baseline | [BV2](../prompts/BV2-reading-log-api.md) | Ready | `task/bv2` | |
| 1 | BV3 | Cover kit: generated cover, format badge, hover actions | baseline | [BV3](../prompts/BV3-cover-kit.md) | Ready | `task/bv3` | |
| 1 | BV4 | Details shell: route group, tabs, contexts, prev/next | baseline | [BV4](../prompts/BV4-details-shell.md) | Done | `task/bv4` | `getBookContext()` shape in the log |
| 2 | BV5 | Quick view drawer | BV1, BV3 | [BV5](../prompts/BV5-quick-view.md) | Ready | `task/bv5` | |
| 2 | BV6 | Details tab | BV1-BV4 | [BV6](../prompts/BV6-details-tab.md) | Ready | `task/bv6` | |
| 2 | BV7 | Files tab | BV1, BV3, BV4 | [BV7](../prompts/BV7-files-tab.md) | Ready | `task/bv7` | |
| 2 | BV8 | Reading Log tab | BV2-BV4 | [BV8](../prompts/BV8-reading-log-tab.md) | Ready | `task/bv8` | |
| 2 | BV9 | Highlights tab + reader `?highlight=` | BV3, BV4 | [BV9](../prompts/BV9-highlights-tab.md) | Ready | `task/bv9` | |
| 3 | BV10 | Integration, real-server E2E, visual QA, full gate | BV1-BV9 | [BV10](../prompts/BV10-integration.md) | Ready | `task/bv10` | |

## Log

Newest first. Format: `YYYY-MM-DD — <task> — what happened (decisions, blockers, follow-ups)`.

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
