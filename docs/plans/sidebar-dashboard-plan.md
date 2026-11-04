# Sidebar, shelves, dashboard, and administration follow-up

Status: Ready for implementation. Requested 2026-11-04.
Baseline: `05326ce` (existing unstaged work committed before planning).
These are local issue specifications: this checkout has no Git remote, so no
GitHub issues were published. Implementation is not part of this planning change.

## Assessment

- The authenticated shell is a light horizontal navigation bar. `/` lists
  libraries, not a dashboard. Catalog APIs already support all visible books
  without a library filter, so All Books needs a route, not a new catalog API.
- Manual private/shared shelves, CRUD, membership, and shelf pages exist.
  System defaults, automatic rules, and reusable sidebar shelf navigation do not.
- Reading progress, `user_books.status`, notes, highlights, and synced user
  settings exist. There is no bookmark entity or cross-book dashboard feed.
- The admin panel manages libraries/access, imports, providers, and maintenance.
  Account creation/reset are CLI-only; account list/update/delete APIs are absent.
- Version is currently `main.version = "dev"` or an injected release tag. The
  image excludes `.git`; neither a commit timestamp nor a UI version API exists.
- Root `dev.cmd` and `dev.ps1` are local launchers, now Git-ignored. They remain
  on disk, but implementation must not depend on them or edit them.

## Product decisions used by these prompts

These are explicit defaults, not claims that the screenshot specifies them:

1. Use the screenshot's structural language: compact header, left navigation,
   generous main pane, cover rows, dark charcoal surfaces, green accents,
   rounded section borders. Keep PandaLibrary branding; do not copy Booklore
   branding, book assets, or its entire toolbar.
2. HOME contains Dashboard (`/`), All Books (`/books`), Bookmarks
   (`/bookmarks`), Notes (`/notes`), in that order. Preserve existing library,
   author, series, tag, reader, search, stats, settings, language, offline,
   logout, and admin features through secondary navigation/header controls.
   The screenshot's Libraries/Magic Shelves groups are not extra requirements.
3. SHELVES contains Unshelved, Favorites, then permitted custom shelves. Its
   title has an accessible right-aligned plus button. Any signed-in user can
   create private shelves; existing shared-shelf permissions remain unchanged.
4. Favorites is a stable per-account manual system shelf. Unshelved is a live,
   read-only view of visible books absent from the viewer's own custom manual
   shelves. Favorites, automatic shelves, and other users' shared memberships
   do not remove books from Unshelved. Both defaults are localized by stable
   identity, protected from rename/delete, and not identified by display name.
5. Custom shelves are manual OR automatic, not a confusing hybrid. Existing
   shelves stay manual. Automatic private shelves use bounded structured
   all/any rules, evaluated against current data at read time. No SQL, regex,
   scripts, or background materialized-membership pipeline is needed.
6. Bookmarks mean saved reading positions, distinct from Favorites and
   highlights. They work in the reader and in an account-scoped cross-book page,
   including existing offline/sync workflows.
7. "Sorts" means dashboard sections, not only a sort-order dropdown. First-use
   defaults, in order: Continue Reading, Recently Added, Read. The top-right
   gear opens section configuration. Users can add/remove/reorder sections,
   add shelf sections, and create a shelf through the same reusable shelf form.
   An explicitly saved empty list stays empty after reload and across devices.
8. Continue Reading uses the viewer's nonzero, incomplete progress, excluding
   finished/abandoned books; newest progress first. Recently Added uses book
   creation time descending. Read uses `user_books.status = 'finished'`, ordered
   by `finished_at`, falling back to `updated_at`, descending. All use ID
   tie-breakers. Never infer finished state merely from a rounded percentage.
9. Dashboard preferences use existing synced `user_settings`, key
   `dashboard.layout.v1`. Section IDs are `continue_reading`, `recently_added`,
   `read`, and `shelf:<positive-id>`. New built-in choices are Unread and Want to
   Read. No arbitrary query-builder or plug-in system is required.
10. Version display is UTC commit date plus short commit hash:
    `YYYYMMDD-HHmmss+<12-character-hash>`, optionally `-dirty`. Commit date is
    the commit's committer timestamp, not build time. Release tags may be shown
    additionally, never instead of provenance. Both normal development and the
    documented container build automatically resolve metadata; the scratch
    runtime never needs Git, Node, or access to the source repository.
11. Account management lives only under `/admin/users`. Include list, create,
    edit username/display name/role/locale, enable/disable, delete, password
    reset, and credential/session revocation. No registration, email recovery,
    impersonation, or external identity system is implied.

## Issues and parallel execution

Run one session per issue in a separate branch/worktree. Do not start a later
wave until the prior wave is merged and green. These waves follow the existing
maximum of four concurrent tasks and serialize schema migrations.

| Wave | Issue | Goal | Dependencies | Migration | Prompt |
|---|---|---|---|---|---|
| 1 | UX1 | Screenshot-inspired shell and All Books | baseline | No | [UX1](../prompts/UX1-sidebar-shell.md) |
| 1 | UX2 | System shelves and automatic rules API | baseline | Yes | [UX2](../prompts/UX2-system-smart-shelves.md) |
| 1 | UX7 | Admin account-management API | baseline | No | [UX7](../prompts/UX7-admin-users-api.md) |
| 1 | UX9 | Automatic commit version in dev/images | baseline | No | [UX9](../prompts/UX9-build-version.md) |
| 2 | UX3 | Sidebar shelves and reusable shelf UI | UX1, UX2 | No | [UX3](../prompts/UX3-shelf-navigation-ui.md) |
| 2 | UX4 | Visibility-safe dashboard feeds API | UX2 | No | [UX4](../prompts/UX4-dashboard-feeds-api.md) |
| 2 | UX6 | Bookmarks, reader, offline sync, page | UX1, UX2 | Yes | [UX6](../prompts/UX6-bookmarks.md) |
| 2 | UX8 | Admin users UI and user selectors | UX7 | No | [UX8](../prompts/UX8-admin-users-ui.md) |
| 3 | UX5 | Dashboard and gear-based configuration | UX3, UX4 | No | [UX5](../prompts/UX5-configurable-dashboard.md) |
| 4 | UX10 | Wire final shell, visual/E2E/release validation | UX1-UX9 | No | [UX10](../prompts/UX10-layout-integration.md) |

UX4 runs after UX2 so catalog shelf/model contracts are stable. UX6 is the only
migration writer in wave 2; UX2 is the only migration writer in wave 1.
UX7 uses existing user/auth tables and must not add a competing migration.

After committing these prompts, create each wave's worktrees from the same
updated `master`, for example:

```powershell
git worktree add ..\pandalibrary-ux1 -b task/ux1 master
```

In each session: `Implement docs/prompts/UX1-sidebar-shell.md` (substitute its
own prompt). Merge/rebase each wave, regenerate sqlc when needed, and run the
combined checks before creating the next wave. Do not launch all ten at once.
Do not use the single main checkout concurrently for different issues.

## Ownership and merge protocol

Each prompt's Owns section is authoritative; do not expand it silently.

- UX1 owns root layout/nav/theme/All Books. UX3 may later replace only the
  sidebar shelf slot. UX10 wires the standalone UX9 version component.
- UX2 owns shelf backend/model/query changes. UX4 adds dashboard-specific
  catalog files/queries only. UX6 owns bookmark/reading/sync changes only.
- UX7 owns backend account operations; UX8 owns admin UI. Neither touches
  shelf or root-shell UI.
- UX9 owns build/version code and workflows; it provides a standalone
  `web/src/lib/buildinfo/BuildVersion.svelte`, not root layout changes.
- Add each HTTP mount to `internal/app/app.go` as its own localized block/line;
  merge additions without reformatting neighboring constructors.
  Use the existing `httpapi.Mount` extension rather than editing
  `internal/httpapi/routes.go` for every feature.
- Use separate SQL query files; generate code with `task sqlc`. Only the
  active migration owner changes generated `models.go` and migration checksum.
  Regenerate rather than manually resolving generated conflicts.
- Localization changes add only `ux1.*`, `ux2.*`, etc. keys to both message
  files; merge by key union. Never manually edit generated Paraglide output.
- Edit only your progress row, your prompt status/hand-off, and append your
  dated log. Architectural changes go in area-specific documents
  (`architecture/ux2-shelves.md`, etc.), linked from your prompt. UX10
  reconciles the architecture indexes/system overview and root README.
- No dependency changes without a demonstrated need. No broad refactors,
  fixture replacements, removed tests, or altered ACLs to satisfy new tests.

## Shared response and UX contracts

- Use the typed API client, `ApiError`, server problem responses, and existing
  authentication/cookie-origin middleware. No client-only authorization.
- Lists use `{items: [], next_cursor: null|string}` with real empty arrays,
  opaque scoped cursors, and existing limits (default 50, maximum 100) unless a
  prompt specifies otherwise. Timestamps are RFC3339 UTC in HTTP DTOs.
- Counts and items apply the same visibility predicate (library grants and
  hidden books); cached/private data must not cross accounts.
- Every UI includes localized English/Chinese copy, accessible icon names,
  keyboard/focus behavior, and explicit loading/empty/error/retry states.
  Keep forms after failures and suppress stale async responses after navigation.
- Do not manufacture success defaults on missing metadata, invalid saved
  configuration, forbidden access, or network failure.
- Backend tasks must record exact endpoint/DTO/examples and validation results
  in their prompt hand-off before dependent work begins. If a necessary
  contract differs from this plan, update its dependent prompts before launch.
- Every task verifies its own behavior with focused tests plus existing
  relevant checks. UX10 verifies the merged application, not only mocks.
