# BH4: Bookheap page, navigation entry, Scan, and bulk Assign/Delete

- Status: Done (`task/bh4`; Assign mocked until BH2 merges)
- Wave: 2; dependencies merged: BH1, BH3
- Can run in parallel with: BH2 (code the assign call against the plan
  contract; mock it in tests until BH2 merges)
- Migration: no
- Branch/worktree: `task/bh4` / `..\pandalibrary-bh4`

## Read first

- [Bookheap plan](../plans/bookheap-plan.md): all decisions, the full shared
  API contract, and the UX contract.
- BH1, BH2 (contract section), and BH3 hand-offs;
  [architecture/bookheap.md](../architecture/bookheap.md).
- `web/src/lib/nav.ts`, `web/src/lib/shell/Sidebar.svelte`,
  `web/src/lib/catalog/{BookBrowser,BookCard}.svelte`,
  `web/src/lib/admin/{poller.ts,PagerFooter.svelte,api.ts}`
  (`listAllAdminLibraries`), `web/src/lib/shelves/**` (shelf listing/types,
  manual vs automatic, writable flags), `web/src/lib/paging`,
  `web/src/routes/books/+page.svelte` (All Books page structure).

## Goal

Admins get a **Bookheap** entry directly below **All Books** in the sidebar.
It opens `/bookheap`, which lists every file in the staging heap with cover,
metadata and status. From there they can **Scan** the server folder, open the
Upload dialog, select many items (including across pages), and bulk **Assign**
them to a library and optional shelves or bulk **Delete** them from the heap,
watching queued items until they are imported.

## Scope

**Owns:**
- `web/src/routes/bookheap/**` (new route, admin-only)
- New modules in `web/src/lib/bookheap/` (for example `HeapList.svelte`,
  `HeapItemRow.svelte`, `ScanControl.svelte`, `AssignDialog.svelte`,
  `selection.svelte.ts`) + unit tests + `bookheap.e2e.ts` (mocked)
- Append list/get/scan/delete/assign functions and types to
  `web/src/lib/bookheap/api.ts` (do not change BH3's exports)
- `bh4.*` messages in both locales

**Shared (localized edit):**
- `web/src/lib/nav.ts`: insert
  `{ id: 'bookheap', href: '/bookheap', label: m['bh4.nav.bookheap'], role: 'admin' }`
  directly after `books` in `homeNavigation`. Make `Sidebar.svelte` apply the
  existing role filter to HOME items (it currently filters only BROWSE). Update
  the nav tests.

**Must not touch:** backend, `UploadDialog`/upload queue internals (reuse
them; report bugs to BH5 or fix minimally with a note), AppShell header,
other routes.

## Requirements

1. **Navigation.** HOME order for admins: Dashboard, All Books, Bookheap,
   Bookmarks, Notes. Non-admins see no Bookheap entry. Active styling follows
   `isActive`. Optionally show a count badge of `ready` items (from
   `total` with `status=ready`), refreshed on `pandalibrary-bookheap-changed`.
   It must not block sidebar rendering.
2. **Route guard.** `/bookheap` for non-admins shows the app's standard
   forbidden state (the server also enforces). Page title "Bookheap".
3. **Toolbar.** Contents:
   - **Scan** starts `POST .../scan` and shows the running state (spinner,
     "Scanning…"). If a scan is already running, it attaches to it. It polls
     `GET .../scan` with the existing `BoundedPoller` until completion, then
     shows a result summary (added, updated, removed, duplicates, invalid,
     skipped, still being written) and refreshes the list. Failures show the
     error with retry. On load, if a scan is running, show and poll it;
   - **Upload** opens BH3's `UploadDialog` (same component, no duplicate form);
   - status filter (All, Ready, Duplicate, Invalid, Queued/Importing, Failed)
     and a debounced search box (`q`), both reflected in the URL query.
     Changing them resets paging and selection.
4. **List.** Each row has a checkbox, cover thumbnail (`cover_url?thumbnail=1`,
   with a placeholder), title, authors, format badge, size, file name/relative
   path, source (Uploaded/Scanned), added date, a status badge with the reason
   (`error`), and a duplicate link to the existing book (`/books/{id}`) where
   relevant. Paging uses cursors with `next_cursor`, matching existing paging
   UX, and shows `total`. States: loading, empty heap (explains Upload and
   copying files to the server folder + Scan), no matches for filter, error with
   retry. Suppress stale responses.
5. **Selection and bulk actions.** Row checkboxes, plus a header checkbox that
   selects or clears the visible page (with an indeterminate state). Selection
   persists across pages and filter-preserving refreshes, up to 500 items, and
   shows a clear "N selected" count with **Clear selection**. When anything is
   selected, a bulk action bar appears:
   - **Assign…** opens `AssignDialog`: a required library select (all
     libraries via `listAllAdminLibraries`), an optional multi-select of
     writable manual shelves (custom manual shelves the admin can write, plus
     Favorites; exclude automatic/Unshelved), an explanation that assigned
     files move into the library and leave the Bookheap, and Confirm. Only
     `ready`/`failed` items are sent, and the dialog says how many selected
     items will be skipped (for example, duplicates or invalid). It calls
     `POST .../assign`, shows per-item failures, keeps the form on a request
     error, and on success clears those items from the selection;
   - **Delete…** opens a confirmation ("Delete N files from the server
     Bookheap? This cannot be undone.") and calls `POST .../items/delete`.
     It reports per-item `busy`/`not_found` results (BH1 also returns
     `changed` when the file on disk no longer matches the item, and `failed`;
     show these as generic per-item failures).
   Actions are disabled while running, and duplicate submissions are prevented.
6. **Live updates.** While any listed item is `queued`/`importing`, poll the
   current page with `BoundedPoller` (around 3 s, bounded). Items that finish
   importing disappear; duplicate/failed ones update in place. After each
   successful mutation and on `pandalibrary-bookheap-changed`, refresh and
   dispatch the event. When books are added to shelves, also dispatch
   `pandalibrary-shelves-changed` so the sidebar counts update.
7. **Accessibility/i18n/responsive.** Localized `bh4.*` copy in English and
   Chinese; labeled checkboxes ("Select <title>"); dialogs follow the
   ShelfCreateDialog focus pattern. Rows collapse to cards on narrow screens,
   and the bulk bar stays reachable.

## Out of scope

- Backend behavior (BH1/BH2). Editing heap item metadata before import (the
  normal book edit page works after import). Bulk actions on library books.

## Acceptance criteria

- [x] Unit tests: nav order/role filtering, selection model (page toggle,
      cross-page persistence, 500 cap, filter reset), assignable/skipped
      counting, assign/delete result mapping, scan polling state machine,
      URL query sync.
- [x] Mocked browser test: admin nav order; empty state; scan running →
      completed summary → list refresh; filter/search/paging; select across
      pages → Assign with library + shelves → queued → item disappears after
      polling; Delete with confirmation; duplicate link; non-admin forbidden
      and no nav entry; Upload button opens BH3's dialog.
- [x] `pnpm --dir web check`, `pnpm --dir web test`, `pnpm --dir web build`
      pass; existing shell/shelf browser tests still pass.

## Validation commands

```powershell
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:e2e -- src/lib/bookheap src/lib/shell/shell.e2e.ts
```

## Hand-off

Record the components/exports, any contract mismatch found against BH1/BH2,
and test results here. Update your progress row and append a dated log.

### BH4 hand-off (2026-11-06)

**Route and navigation.** `/bookheap` (`web/src/routes/bookheap/+page.svelte`)
checks the session viewer and shows `admin.forbidden` to non-admins; the page
itself is `BookheapPage.svelte`. `nav.ts` adds the admin-only `bookheap` HOME
entry and `homeNavigationFor(role)`; `Sidebar.svelte` renders it with
`BookheapCount.svelte` (ready-item badge from `status=ready&limit=1` `total`,
refreshed on `pandalibrary-bookheap-changed`, silent on errors).

**Exports in `web/src/lib/bookheap/`** (BH3 exports unchanged):

- `api.ts`: `HEAP_PAGE_SIZE` (50), `MAX_BULK_IDS` (500), `MAX_ASSIGN_SHELVES`
  (20), `HeapScan`, `HeapPage`, `HeapItemResult`, `HeapAssignResult`,
  `buildHeapItemsPath`, `listHeapItems`, `getHeapItem`, `startHeapScan`,
  `getHeapScan`, `deleteHeapItems`, `assignHeapItems`, `heapThumbnailUrl`.
- `query.ts`: URL sync (`heapQueryFromSearch`/`heapQueryToSearch`) and
  `fetchHeapPage` (merges `queued` + `importing` for the combined filter).
- `selection.svelte.ts`: `HeapSelection` (500 cap, page toggle, `sync`),
  `partitionAssignable`, `isAssignable`, `isActive`.
- `heap-list.svelte.ts`: `HeapList` (Load more paging, in-place `refresh()` of
  the shown pages, stale responses dropped).
- `scan.svelte.ts`: `ScanController` (start/attach/poll with `BoundedPoller`,
  `stalled` after the budget, retry).
- `results.ts`: per-item code → message mapping; `targets.ts`: writable manual
  shelves (Favorites + shared + own private; no automatic/Unshelved).
- Components: `BookheapPage`, `ScanControl`, `HeapItemRow`, `AssignDialog`,
  `DeleteDialog`, `BulkResults`, `HeapDialog`, `BookheapCount`. Upload reuses
  BH3's `UploadDialog`.

**Contract notes / mismatches.**

- BH1's list endpoint accepts a single `status`. The plan's Queued/Importing
  filter (`status=active` in the page URL) is done client-side by paging both
  statuses and merging by `created_at desc, id desc` with a composite cursor.
  If BH2/BH5 adds a multi-status filter, `fetchHeapPage` can call it directly.
- Assign uses the plan contract (`POST /admin/bookheap/assign`
  `{ids, library_id, shelf_ids}` → `202 {results:[{id, ok, error,
  import_job_id}]}`); it is mocked only. 404 → "library or shelf no longer
  exists", 400/422 → "cannot receive these books". Per-item codes
  `not_found`, `not_assignable`, others → generic failure. BH5 must verify it
  against BH2's real endpoint. BH2 (done) matches this contract and adds the
  per-item codes `changed` and `failed` (generic failures here); shelf
  problems carry a `shelf_id` extension.
- Delete shows `busy`/`not_found` specifically; `changed`/`failed` are generic.
- Missing per-item results are reported as failures, not successes.

**Tests.** Unit: `nav.test.ts` (order, role filtering, bh4 en/zh key parity),
`query`, `selection`, `results`, `scan`, `heap-list`, `targets` tests.
Browser (mocked): `src/lib/bookheap/bookheap.e2e.ts` (6 tests); the Chinese
admin shell test now expects 书堆 in HOME. `pnpm --dir web check`, `test`,
`build` and the full mocked Playwright suite pass.
