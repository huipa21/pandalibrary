# UX5: Dashboard cover rows and gear-based section configuration

- Status: Review (full frontend check has pre-existing failures)
- Wave: 3; dependencies merged: UX3, UX4 (and their prerequisites)
- Branch/worktree: `task/ux3` / `C:\other\pandalibrary`; migration: no

## Read first and ownership

Read [the plan](../plans/sidebar-dashboard-plan.md), UX3/UX4 hand-offs,
existing book cards/reader URLs, typed APIs, user_settings sync, and offline
account patterns. Own root `web/src/routes/+page.svelte`, new
`web/src/lib/dashboard/**`, dashboard-focused tests, and `ux5.*` messages.
Reuse public components/helpers; do not edit shell, shelf component internals,
admin, reader, sync schema, backend, or build files.

## Implement

1. `/` is now the Dashboard. Show cover rows for Continue Reading, Recently
   Added, Read, in that order on first use. Follow screenshot-inspired rounded
   section panels, readable headings/green accents and cover proportions.
   Use existing catalog/media/reader navigation and safe format handling.
   Continue Reading must resume via the existing progress-aware reader, not
   invent a locator or silently choose the wrong book file.
2. Put one accessible gear button at the top-right of the main content area.
   Its configuration dialog can add, remove, and reorder sections, including
   removing every section. Offer all UX4 built-in feed types and permitted
   numeric shelf sections (including Favorites and automatic shelves).
   Prevent duplicate section IDs; do not expose hidden shelves.
3. Store preferences under synced setting `dashboard.layout.v1`:
   `{version:1,sections:[{id:"continue_reading"},...]}`; shelf ID is
   `shelf:<positive-id>`. Read/write through existing account-scoped durable
   sync helpers so changes persist across reloads/devices and offline.
   Missing setting alone means defaults. A saved `sections:[]` means no
   sections, not missing data. Corrupt/unsupported values show an explicit
   recover/reset action instead of silently restoring defaults.
4. Expose both Add shelf section (select an existing shelf) and Create shelf
   (UX3's ShelfCreateDialog). After creation offer/add its shelf section and
   honor the user's selection. Preserve the shared
   `pandalibrary-shelves-changed` refresh event. Deleted/inaccessible shelf
   sections show a removable unavailable state without leaking metadata.
5. Each row handles initial load, real empty data, partial failures, retry,
   opaque next-page loading and stale requests independently. One feed failing
   must not erase the other rows. Avoid unbounded fetches or nested viewport
   scroll traps; provide keyboard-operable row navigation/load more.
6. Distinguish an empty configured dashboard from a dashboard whose feeds are
   empty; keep gear/Create shelf actions available in both. Respect narrow
   layouts, accessible headings/dialog focus, both locales, account switches,
   offline notices, and unsuccessful sync/conflict results.

## Acceptance and validation

Test first-use defaults, add/reorder/remove, persisted zero sections, corrupt
settings recovery, cross-account isolation, sync/offline persistence, shelf
creation/selection/deletion, permission errors, partial feed failures,
pagination and resume navigation. Use real-server browser coverage for the
main saved-configuration flow, not only local-storage mocks.
Run frontend check, focused units/browser tests and build. Record exact
commands/results and update your prompt/progress row/log.

## UX5 hand-off

- The root page now renders independently loaded dashboard rows with the three
  first-use defaults and a gear dialog for adding, removing, and ordering all
  five built-in feeds and permitted numeric shelves. The shared UX3 shelf
  creator is used from both the page and configuration dialog.
- `dashboard.layout.v1` is account-scoped and uses the existing durable
  settings/outbox sync. An explicitly empty layout stays empty; invalid or
  unsupported layouts require an explicit reset. Unsynchronized offline data,
  failed saves, and stale or rejected mutations are surfaced rather than
  silently replaced. Continue Reading resolves the exact saved, supported file.
- Rows fetch at most 12 books per page and start near the viewport. Shelf
  selection is paged, metadata checks are bounded, stale requests are ignored,
  and inaccessible shelves show a generic removable state. The UX3 dialog is
  promoted to a native modal by its dashboard parent without changing UX3.

### Validation (2026-11-04)

- `pnpm --dir web test -- --no-file-parallelism`: 24 files, 189 tests passed.
- `pnpm --dir web exec vitest run src/lib/dashboard`: 17 tests passed.
- `pnpm --dir web build`: passed.
- With `PANDA_E2E_BINARY` pointing to an isolated server built with
  `$env:CGO_ENABLED = '0'; go build -o $binary .\cmd\pandalibrary`,
  `pnpm --dir web exec playwright test dashboard.e2e.ts dashboard-real.e2e.ts --workers=1`:
  12 passed. This includes real-server shelf creation, cross-device settings,
  offline reload, and reconnect synchronization.
- An isolated `pnpm --dir web exec svelte-check --tsconfig
  .\tsconfig.ux5-check.tmp.json --fail-on-warnings` passed with zero errors
  and warnings. Its temporary configuration supplied the existing UX3
  dialog's public prop declaration
  to isolate its pre-existing diagnostic; those temporary files were removed.
  The real dialog was exercised by browser tests.
- `pnpm --dir web check` still fails with 11 errors and 6 warnings in the
  pre-existing `UserForm.svelte`, `admin/users/+page.svelte`, and
  `ShelfCreateDialog.svelte`. These files are outside UX5 ownership. The task
  remains in Review until the shared full-check baseline is repaired.
