# BH5: Bookheap integration, real-server E2E, docs, and release checks

- Status: Done (2026-11-06, branch `task/bh5` on top of `task/bh4`)
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

- [x] New real-server suite passes; all existing browser and unit suites pass.
- [x] `task sqlc:check lint test build`, `pnpm --dir web check test build`, and
      the full `pnpm --dir web test:e2e` pass.
- [x] README/architecture updated; progress board rows BH1-BH5 accurate.

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

### BH5 hand-off (2026-11-06)

**Added**

- `web/src/routes/bookheap.e2e.ts`: 6 serial real-server tests, no mocks.
  - Header Upload with remove (X), re-select dedupe and a duplicate of a
    library book. The result is "2 uploaded, 1 duplicate, 0 failed", and the
    files land in `<data>/bookheap`.
  - Scan of subfolder EPUB, PDF and CBZ books, a non-book file and a corrupt
    EPUB gives Added 4, Invalid 1, Skipped 1; a rescan adds nothing.
  - 50 seeded books, selection across pages with Load more, then Assign to a
    library and a private shelf. The books are verified on the library page,
    the shelf page, All Books, search and Admin → Imports (source "Bookheap"),
    and their heap files are gone.
  - Bulk Delete of the invalid item removes its file.
  - A reader sees no Upload or Bookheap entry and gets 403 from the heap APIs.
  - A drop-folder import into `<drop>/<slug>/` still works.
  - Cleanup removes only the suite's heap fixtures, books, library, shelf and
    import history so later suites do not inherit them.
- `web/scripts/bookheap-restart-check.mjs`: a restart check, also added to CI
  after the browser suite. It does the following:
  1. Indexes 150 books and starts one assignment, with a large metadata
     fixture first so that an import remains active.
  2. Kills the server after observing an active job, and reads the stopped
     database to require at least one pending or processing job on disk.
  3. Restarts on the same data and checks that pending jobs finish and every
     item is either imported or still `ready`/`failed` with its file present.
  4. Reassigns the leftovers.
  5. Asserts the heap index and folder are empty, all 150 jobs imported, the
     library and shelf both list 150 books, no import manifests remain, and a
     rescan changes nothing.
- Docs:
  - `README.md`: Bookheap workflow, header Upload, `PANDA_BOOKHEAP_DIR`
    default, container UID/permission notes, backup coverage (DB rows, not
    heap files), and the restart-check command.
  - `docs/architecture/bookheap.md`: workflow, lock fix and verification.
  - `docs/architecture/system.md` and `docs/README.md` now link `bookheap.md`.

**Integration fixes**

1. `internal/importer/hook.go`, `service.go`: **deadlock** when assigning while
   workers run, which happened at about 150 items or with realistic books.
   - Cause: a worker in its book transaction (holding the single writer
     connection) called `hook()`, which took the importer mutex. Meanwhile
     `enqueueWith` held that mutex and waited for the writer. The assign
     request hung until it got a 500, and imports stalled.
   - Fix: hooks now have their own `hooksMu` RWMutex.
   - Regression test: `TestAssignWhileImporterRuns` in
     `internal/bookheap/assign_test.go`. It assigns 150 items with a running
     importer; it timed out before the fix and passes after it.
2. `web/src/routes/admin/imports/+page.svelte` plus the `bh5.imports.source.bookheap`
   message (en/zh): the import history showed the raw source `bookheap`; it
   now shows "Bookheap" / "书堆".
3. `web/src/routes/admin.e2e.ts`, `release.e2e.ts`: BH3's header Upload button
   made the existing `Upload` locators ambiguous (strict-mode violation).
   They are now scoped to `main`.
4. `web/src/routes/ux-integration.e2e.ts`: this was already failing on master.
   Commit `2566569` changed the sidebar footer to the compact `YYMMDD-commit7`
   version, but the test still expected the full version. It now expects the
   compact form.
5. `internal/importer/watcher_test.go`: job status can become final before
   asynchronous drop-folder cleanup finishes. Wait for all three source files
   to be removed before asserting the archived files and failure sidecar.
6. `internal/bookheap/bookheap_test.go` and the real-server suite now verify
   concurrent scan starts deterministically and scan EPUB, PDF and CBZ files.

**Results**

| Check | Result |
|---|---|
| `task sqlc:check lint test build` | Passes (343 top-level Go tests) |
| `pnpm --dir web check` | 0 errors, 0 warnings |
| `pnpm --dir web test` | 252 tests in 34 files pass |
| `pnpm --dir web build` | Passes |
| `pnpm --dir web test:e2e` with `PANDA_E2E_BINARY` | 74 pass, including the 6 new tests |
| Focused Bookheap browser suites | 12 pass, including EPUB/PDF/CBZ rescanning |
| Linux Bookheap scan tests | Pass, including real symlink rejection |
| `bookheap-restart-check.mjs` | 4 Windows and 1 Linux passes, each with a persisted unfinished job at the crash; an injected HTTP failure is surfaced |
| Production image via Podman | Build, version, healthcheck and heap-directory creation pass |

**Skipped or substituted**

- Docker is not installed, so the image was built with Podman:
  `podman build --env GOPROXY=https://goproxy.cn,direct` with npm registry
  overrides and the `COMMIT`/`COMMIT_DATE`/`DIRTY` build args. The wrapper
  `scripts/build-container.mjs` could not be used because the Podman VM
  cannot reach `proxy.golang.org`; the first image rebuild also encountered
  npm registry timeouts.
- The image starts, `/healthz` returns `ok`, and UID 65532 creates
  `/data/bookheap`.
- `container-check.mjs` was not run.
- The race detector was not run (it needs CGO and a C compiler is unavailable).

**Follow-ups**

- **High:** importing any EPUB, FB2 or MOBI whose non-ISBN identifier has no
  recognized scheme fails for every source (upload, drop and bookheap). The
  extractors emit scheme `identifier`, which the `book_identifiers` CHECK
  constraint rejects (see `internal/extract/epub/epub.go` `parseIdentifier`).
  Map unknown schemes to a skip or an allowed scheme.
- Uploads by non-admins.
- Editing heap metadata before import.
- Bulk actions for library books.
