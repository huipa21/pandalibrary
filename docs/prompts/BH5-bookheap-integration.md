# BH5: Bookheap integration, real-server E2E, docs, and release checks

- Status: Ready (after BH1-BH4 are merged into `master`)
- Wave: 3; dependencies merged: BH1, BH2, BH3, BH4
- Can run in parallel with: nothing (integration gate)
- Migration: no
- Branch/worktree: `task/bh5` / `..\pandalibrary-bh5`

## Read first

- [Bookheap plan](../plans/bookheap-plan.md) and the hand-offs in BH1-BH4.
- [architecture/bookheap.md](../architecture/bookheap.md),
  [architecture/system.md](../architecture/system.md), root `README.md`,
  `Dockerfile`, `web/playwright.config.*`, the existing real-server E2E files
  in `web/src/routes/*.e2e.ts` (for example `ux-integration.e2e.ts`,
  `admin.e2e.ts`, `release.e2e.ts`) and their server fixtures.

## Goal

Prove the merged feature works end to end against the real server, fix the
integration defects found, and document it. Specifically: header Upload →
heap folder + rows → Bookheap page → Scan of server-copied files → bulk
Assign to a library and shelves → books appear in the library and on the
shelves, and their files have left the heap.

## Scope

**Owns:** `web/src/routes/bookheap.e2e.ts` (new real-server suite), any
E2E fixture additions, `README.md` (feature + configuration + Docker volume
notes), `docs/architecture/system.md` and architecture index links, the
progress board/log for BH5, and minimal integration fixes in BH1-BH4 files.
Note each fix in the hand-off. Feature redesign is not allowed; if a contract
is wrong, record it as a follow-up.

## Requirements

1. **Real-server E2E** (no API mocks), using the existing harness
   (`PANDA_E2E_BINARY` + `web/scripts/e2e-server.mjs`). The heap is the default
   `<PANDA_E2E_DATA_DIR>/bookheap`, so tests can write to it directly. Only
   extend `e2e-server.mjs` if a separate directory is truly needed. The suite
   must pass serially (`workers: 1`) without leaking state into the other
   suites:
   - admin opens Upload from the header, drops/selects two fixture books and
     one duplicate of an existing library book, removes one with X, re-selects
     to verify dedupe, uploads, and sees mixed results; the files exist in the
     heap directory;
   - the test copies a fixture book (in a subfolder) and a non-book file into
     the heap directory, clicks Scan, waits for the summary, and sees the new
     item and correct counts;
   - select items across pages (lower the page size through the URL limit if
     supported, or seed enough items), Assign to a library and a manual shelf,
     wait until they disappear from the heap, then verify on the library page,
     the shelf page, All Books, search and import history (source `bookheap`).
     The heap files are gone;
   - bulk Delete an invalid item; its file is gone;
   - a non-admin sees neither the header Upload nor the Bookheap nav, and
     `/api/v1/admin/bookheap/*` returns 403;
   - the existing `/admin/imports` upload and the drop folder still work
     (existing suites stay green).
2. **Restart check:** with an assignment queued, restart the server process
   (using the existing release/restart harness if present). The job completes
   or fails cleanly, and the heap state is consistent.
3. **Docs:** README sections for uploading through the header, the Bookheap
   workflow (upload or copy files + Scan, then Assign), the
   `PANDA_BOOKHEAP_DIR` setting and its default, and the Docker volume/permission
   notes (the folder is under the data volume by default). Link
   `architecture/bookheap.md` from the architecture index/system overview.
   Mention that backups cover the database (heap rows) but heap files live in
   the heap folder.
4. **Release gates:** full Go and web gates, the full browser suite, and the
   container build (if Docker is available locally; otherwise record that it was
   skipped and why).

## Acceptance criteria

- [ ] New real-server suite passes; all existing browser and unit suites pass.
- [ ] `task sqlc:check lint test build`, `pnpm --dir web check test build`, and
      the full `pnpm --dir web test:e2e` pass.
- [ ] README/architecture updated; progress board rows BH1-BH5 accurate.

## Validation commands

```powershell
task sqlc:check
task lint test build
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
task build
$env:PANDA_E2E_BINARY = (Resolve-Path .\pandalibrary.exe).Path; pnpm --dir web test:e2e
docker build -t pandalibrary:bookheap .
```

## Hand-off

Record exact test counts, the integration fixes made (file + reason), skipped
checks with reasons, and follow-ups (for example non-admin uploads, heap
metadata editing before import, or bulk actions for library books). Set this
prompt and the plan to Done, and append a dated log.
