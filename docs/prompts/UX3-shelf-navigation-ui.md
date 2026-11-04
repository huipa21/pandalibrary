# UX3: Live sidebar shelves and reusable shelf creation/rules UI

- Status: Ready
- Wave: 2; dependencies merged: UX1, UX2; migration: no
- Branch/worktree: `task/ux3` / `..\pandalibrary-ux3`

## Read first and ownership

Read [the plan](../plans/sidebar-dashboard-plan.md), UX1/UX2 hand-offs, existing
`web/src/lib/shelves/**`, shelf routes, and request/paging patterns.
Own those shelf files/tests, new system-shelf routes/components, and only the
SHELVES slot in UX1's sidebar. Add `ux3.*` messages in both locales.
Do not edit dashboard/root landing, catalog backend, admin, reader/sync, global
theme, version footer, or shared catalog components.

## Implement

1. Export `web/src/lib/shelves/ShelfNavigation.svelte` and wire it into UX1's
   shelf slot. Render SHELVES with a right-aligned, accessible plus button;
   show Unshelved, Favorites, then permitted custom shelves with visible counts
   and active styling. Do not list the numeric Favorites shelf twice.
2. Use `/shelves/system/unshelved` and `/shelves/system/favorites` frontend routes,
   backed by UX2's literal system API routes. Preserve numeric custom-shelf
   links. Default labels use localized stable keys, not comparisons to names.
   Make long lists scroll/page without hiding the footer or loading the entire
   book catalog. Provide meaningful retry/empty/loading states.
3. Create reusable `ShelfCreateDialog.svelte`, accepting
   `open: boolean`, `onclose: () => void`, and
   `oncreated: (shelf: Shelf) => void`. On successful creation invoke
   `oncreated`; the parent closes it. Trap/restore focus appropriately,
   Escape cancels, and failed forms keep their values. The plus button and
   UX5 dashboard must use this same component, not duplicated forms.
4. Extend shelf creation/editing with Manual / Automatic selection at creation,
   a bounded all/any rule builder matching UX2's exact contract, natural labels,
   validated selectors, and explicit invalid-rule errors. Retain private/shared
   behavior; shared is available only where the server permits it. Explain why
   an existing shelf's mode cannot be changed.
5. Keep rename/delete/add/remove/reorder for permitted manual custom shelves.
   Favorites supports membership but no rename/delete/rules. Automatic shelves
   show/edit rules, but never offer manual membership/reordering. Unshelved is
   read-only. AddToShelf offers only writable manual targets, not automatic
   or virtual shelves. Deleting a shelf never deletes its books.
6. After successful shelf CRUD/membership changes, dispatch
   `window` event `pandalibrary-shelves-changed` (no sensitive payload).
   ShelfNavigation listens and refreshes, cleans up listeners on unmount, and
   discards stale responses. UX5 uses the same event for shelf panels.
7. Export typed system metadata/book APIs and updated Shelf types. Existing
   manual-shelf clients must remain compatible. Handle missing/deleted shelves,
   server permission changes, pagination resets, errors and account switches.

## Acceptance and validation

Any signed-in user can create a private shelf from the sidebar; automatic
results update after source data changes; defaults and counts stay correct.
Both locales, keyboard/dialog interactions, manual regression, dynamic
refresh, stale/failed requests, and forbidden paths have focused tests.
Run frontend check, focused unit tests, build, and focused real-server shelf
browser tests. Record the exported component/API/event contracts and exact
results in this prompt; update your progress row/log.
