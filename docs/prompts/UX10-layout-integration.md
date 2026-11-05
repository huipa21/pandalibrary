# UX10: Final layout wiring, visual verification, and regression gate

- Status: Done
- Wave: 4; dependencies merged: UX1-UX9; migration: no
- Branch/worktree: `task/ux10` / `..\pandalibrary-ux10`

## Read first and ownership

Read [the plan](../plans/sidebar-dashboard-plan.md), every UX hand-off,
progress board, release/browser test setup, and current architecture docs.
Own final root-shell composition, cross-feature styling/accessibility fixes,
integration/browser/release checks, root README, architecture/index updates,
and your own prompt/progress row. Do not rewrite completed features or
introduce new product scope; fix only integration regressions with focused
tests and coordinate any necessary owned-area changes after owners are done.

## Implement and verify

1. Wire UX9's `BuildVersion` into UX1's bottom sidebar footer, with long-menu
   scrolling that leaves the version accessible. Confirm UX3's live shelf
   navigation and plus dialog are present, not the initial UX1 placeholder.
2. Default authenticated entry is UX5's dashboard; HOME contains exactly the
   requested four primary entries. Secondary destinations remain reachable,
   including the old library index. Users management appears only within the
   admin area. No dangling placeholders, duplicate Favorites, or dead routes.
3. Verify screenshot-inspired desktop layout and mobile drawer in a real
   browser. Inspect login/setup, All Books/detail, shelves/rules, bookmarks,
   notes, reader, dashboard configuration and admin users in both languages.
   Capture representative screenshots with normal populated data and with
   empty/long content. Check contrast, focus order, responsive overflow,
   reader sizing, dialog escape/focus return, and independent scrolling.
4. Exercise real flows: create manual/automatic shelf using sidebar; manually
   add/remove books; update rule input data and see automatic results; verify
   Unshelved/Favorites/counts; add shelf from dashboard; add/reorder/remove all
   dashboard sections, reload and verify zero persists; restore intentionally.
5. Verify per-user default feeds and accurate resume, save/edit/delete bookmark
   online/offline and sync to another session, account switching, hidden-book
   counts/feeds, and denial for ordinary users reaching account admin APIs.
   Admin flow includes create/edit/disable/delete/reset/revoke and last-admin
   guard; preserve existing providers/imports/maintenance/grants/hide lists.
6. Verify footer, CLI and `/api/v1/version` against the exact current commit
   date/hash in development and actual container image. Use UX9's documented
   automatic build path, no hand-entered fake provenance. Confirm a runtime
   without Git is healthy and persistent storage survives restart.
7. Reconcile current documentation: root README development/image version
   commands and UI behavior, architecture system/database indexes and
   area-specific UX docs. Preserve historical implementation logs; close W5's
   account gap by documenting the new API/UI, not erasing its history.

## Acceptance and validation

Run `task sqlc:check`, `task build`, `task lint`, `task test`,
`pnpm --dir web check`, `pnpm --dir web test`,
`pnpm --dir web build`, full real-server Playwright suite, and existing
upgrade/container checks (build the final binary/assets first as required).
Check upgrade from the pre-UX schema preserves users, shelves, annotations,
book files and offline settings. Do not replace real tests with mocked routes
or skip failed coverage. Record exact results and any environment blockers
truthfully; do not declare container/visual checks passed without running them.

Close only after all requested behavior is integrated, tests pass, current
docs match, no local dev launcher was committed, and the worktree contains
only intended changes. Update your prompt/progress row/log with evidence.

## Integration hand-off

- Root footer renders UX9 `BuildVersion`; HOME retains the four primary
  entries, with secondary/admin routes outside HOME. UX3 shelf navigation
  has live counts and a shared native-modal creator with Escape/focus return.
- Fixed cross-feature shelf membership refresh and system/custom page
  rendering. Dashboard feed pagination now uses bounded SQL keysets.
- Real-server tests share first-run credentials and run with one worker
  against a unique temporary database/port. Actions time out after 10 seconds,
  navigation after 20 seconds; the full verification run has an 8-minute cap.
  Fixed stale fixtures after replacing the shell placeholder and adding the
  build footer. Frontend builds complete before Go embed builds/tests.
- Upgrade baseline checks users/library, shelf membership, highlights/notes,
  reader settings, stored file metadata and exact file bytes. IndexedDB legacy
  settings/notes preservation is checked separately by the sync unit suite.
- Actual scratch-image checks include automatic commit stamping, no Git/PATH,
  non-root execution, compressed size <=35 MiB, API/CLI provenance, health,
  setup, migrations, shutdown and database/session persistence after restart.
  Generated frontend output is excluded from the build context; `.dockerignore`
  stays LF so Podman on Windows interprets its exclusions correctly.
- Representative browser screenshots cover populated/empty dashboards,
  account management, All Books/detail, shelves, bookmarks and notes in both
  languages, plus desktop/mobile layouts and long bilingual shelf names.

### Verified release gate (2026-11-05)

- `task sqlc:check`, `task build`, `task lint`, `task test`: passed.
- `pnpm --dir web check`: 0 errors/warnings; `pnpm --dir web test`:
  26 files, 204 tests passed; `pnpm --dir web build`: passed.
- `node scripts/build-binary.mjs --output <candidate>` followed by
  `PANDA_E2E_BINARY=<candidate> pnpm --dir web exec playwright test
  --global-timeout=480000 --reporter=line`: all 58 tests passed (2.7 minutes).
  Real-server account/bookmark/shelf workflows supplement existing mocked
  error/permission fixtures; no failing tests were skipped or retried away.
- `PANDA_CANDIDATE_BINARY=<candidate> node web/scripts/upgrade-check.mjs`:
  passed against the generated v1 baseline with all preservation fixtures.
  No prior published release binary was available.
- `node --test scripts/build.test.mjs`: 3 passed.
- `CONTAINER_ENGINE=podman node web/scripts/container-check.mjs`: passed
  against the actual non-root scratch image, 11.4 MiB compressed, including
  retained account/session/library after restart. CLI/API stamps match the
  checkout; the real browser verifies footer/full commit/date.
- Inspected real account, populated bookmark/dashboard and narrow shelf
  screenshots. Explicit locale changes verify Chinese rather than merely
  naming English screenshots as Chinese. A focused real-shelf/locale run
  also passed after this screenshot assertion was strengthened.
- Current README, architecture/indexes and UX6/UX8 hand-offs are reconciled.
  Historical W5 logs remain unchanged; its missing account UI is now supplied.
