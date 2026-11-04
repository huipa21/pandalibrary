# UX1: Screenshot-inspired sidebar shell and All Books

- Status: Review (see hand-off below)
- Wave: 1; dependencies: baseline `05326ce`; migration: no
- Branch/worktree: `task/ux1` / `..\pandalibrary-ux1`

## Read first

Read [the follow-up plan](../plans/sidebar-dashboard-plan.md), especially product
decisions and ownership. Inspect `web/src/routes/+layout.svelte`, `layout.css`,
`web/src/lib/nav.ts`, `nav.test.ts`, catalog components/API, existing auth/offline
flows, and shell/browser tests. The screenshot is a structural reference;
implement its described visual language even when the attachment is unavailable.

## Owns

- Root layout, `layout.css`, `web/src/lib/nav.ts` and its tests.
- New `web/src/lib/shell/**`, `/books/+page.svelte`,
  `/libraries/+page.svelte`, and shell-focused tests.
- `web/src/routes/+page.svelte` only to move the existing library-list
  implementation to `/libraries` and leave a clearly temporary dashboard
  landing page. UX5 replaces it after wave 2.
- Add only `ux1.*` localization keys and update your own progress/prompt.

Do not touch backend, admin, reader/sync, shelf CRUD components, build/version
code, or existing book-card internals. Preserve the existing catalog component
API. UX3 later owns shelf-slot wiring; UX10 later wires version display.

## Implement

1. Replace horizontal primary navigation with a compact persistent header and
   fixed-width left sidebar on desktop. Use dark charcoal/green accents,
   readable contrast, selected-row highlighting, rounded panels, and flexible
   main width; approximate screenshot proportions (sidebar about 240-260px).
   Avoid a narrow centered content column or horizontal viewport overflow.
2. HOME links, in order: Dashboard `/`, All Books `/books`, Bookmarks
   `/bookmarks`, Notes `/notes`. Active matching must not mark All Books
   active on every `/books/<id>` subpage unless deliberately documented.
   Keep all existing destinations reachable through secondary navigation;
   preserve role-filtered Admin access, header search, locale/profile/settings,
   logout, sync notices, and first-run/login behavior.
3. Add `/books` using `BookBrowser` with an unrestricted library scope: let the
   server select all visible books. Preserve filtering, sorts, paging, grid/list,
   deep links, and book/reader actions. Move the old library index to
   `/libraries` without changing `/library/{id}` URLs.
4. Provide an isolated sidebar SHELVES slot, initially using existing shelf
   links and a create link to the current shelves page. Do not invent system
   shelf responses or depend on UX2's in-flight files. Mark the slot in the
   hand-off so UX3 can replace it with `ShelfNavigation`.
5. Reserve a bottom sidebar footer for UX9's eventual `BuildVersion` component;
   do not fabricate a version. UX10 performs the actual import/wiring after
   both branches merge. The footer remains visible with an internally
   scrollable long menu.
6. On small screens provide an accessible collapsible/drawer sidebar:
   keyboard toggle, expanded state, Escape/close, focus return, close on
   navigation, and no obscured content. Keep reader full-screen behavior usable.
7. Preserve existing route and offline/account guards. Avoid making a global
   dark background render existing light-page content unreadable; provide
   scoped shell/content styling or compatible tokens, not indiscriminate CSS
   overrides. UX10 checks feature-page consistency.

## Acceptance and validation

- All four HOME links, secondary features, admin role gating, library move,
  and All Books navigation work; auth/setup remain usable.
- Desktop and narrow/mobile screenshots show the requested two-column layout.
- Focused nav/unit/Playwright tests cover active links, collapse/focus,
  no horizontal overflow, existing routes, and both locales.
- Run `pnpm --dir web check`, focused `pnpm --dir web test -- <selectors>`,
  `pnpm --dir web build`, and focused shell/auth/catalog browser tests using
  the repository's real-server setup.
- Update stale shell assertions only for intentional layout changes, not to
  weaken permission/reader/offline tests. Record exact commands/results and
  shelf/footer slot contracts in your hand-off.

## Hand-off (2026-11-04)

Implemented on `task/ux1`.

- Shell: `web/src/lib/shell/AppShell.svelte` (header, sidebar/drawer, main
  panel), `Sidebar.svelte`, `SidebarShelves.svelte` (placeholder),
  `AccountControls.svelte`, `focus.ts`. `+layout.svelte` keeps its auth/offline
  logic and only wraps it in `<AppShell>`. Theme tokens (`--color-shell-*`,
  `--spacing-shell-*`) and `.shell-*` classes live in `layout.css`.
- Navigation (`web/src/lib/nav.ts`): HOME = Dashboard `/`, All Books `/books`,
  Bookmarks `/bookmarks` (page owned by UX6), Notes `/notes`. BROWSE =
  Libraries, Authors, Series, Tags, Read, Search, Stats, Admin (admin only).
  All Books is active only on exact `/books`; Libraries is active on
  `/libraries` and `/library/*`. `/read/<book>/<file>` is immersive: the
  sidebar opens only as a drawer.
- Below 64rem the sidebar is a modal drawer: focus moves in, Tab is trapped,
  Escape and navigation close it and focus returns to the toggle. Settings,
  sign-out and language appear in the header on desktop and in the drawer on mobile.
- Pages: `/books` renders `BookBrowser` with an empty scope. The former index
  moved to `/libraries`, and back links now point there. `/` is a temporary
  API-free dashboard (`data-temporary-dashboard`) for UX5 to replace.
- Catalog: `allowsCatalogFilters(scope)` now enables library/format/language
  filters for any scope without a fixed author/series/tag. Option values are
  strings, so deep-linked filter values display correctly; before this,
  numeric values never matched the URL string.
- i18n: 25 `ux1.*` keys in `en.json`/`zh.json`; parity is unit-tested.

### Slot contracts

- Shelves (UX3): pass a `shelves` snippet to `<AppShell>`/`<Sidebar>`, or
  replace the `SidebarShelves` default in `Sidebar.svelte`. Keep the root marked
  `data-slot="sidebar-shelves"`; it sits between HOME and BROWSE. Shelf links
  duplicate main-page links, so scope browser assertions to `getByRole('main')`.
- Footer (UX9/UX10): pass a `footer` snippet to `<AppShell>` in
  `+layout.svelte` (for example `{#snippet footer()}<BuildVersion />{/snippet}`).
  It renders in `footer[data-slot="sidebar-footer"]`, pinned below the
  scrolling nav.

### Validation

- `pnpm --dir web check` — 0 errors, 0 warnings.
- `pnpm --dir web test` — 172 passed. One parallel run timed out
  `reader.test.ts` (5 s) under machine load. It passed in isolation, with
  `--no-file-parallelism`, and on rerun.
- `pnpm --dir web build` — succeeds.
- Real server: `go build -o $env:TEMP\pandalibrary-ux1-e2e.exe ./cmd/pandalibrary`
  (with `CGO_ENABLED=0`, after the web build), `PANDA_E2E_BINARY` set, then
  `pnpm --dir web exec playwright test --workers=3` — 43 passed. This includes the new
  `src/lib/shell/shell.e2e.ts` (desktop layout/overflow/active state, admin
  and zh labels, mobile drawer keyboard flow, public login without sidebar).
- Stale assertions updated only for intentional changes: the catalog locale
  test opens `/libraries`; one shelves assertion is scoped to `main`.
