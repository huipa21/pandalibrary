# UX1: Screenshot-inspired sidebar shell and All Books

- Status: Ready
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
