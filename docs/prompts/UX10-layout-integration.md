# UX10: Final layout wiring, visual verification, and regression gate

- Status: Ready
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
