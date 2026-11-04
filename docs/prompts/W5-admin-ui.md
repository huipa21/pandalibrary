# W5: Admin UI

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § Step 10
- Depends on (merged): I1, M1, W1, J1
- Can run in parallel with: W6, W7
- Branch / worktree: `task/w5` in `..\pandalibrary-w5`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§5–6, 11–12, 15
- [architecture/database.md](../architecture/database.md) §§1–5, 8
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- [C1 library/access and hide-list API](./C1-catalog-core.md),
  [I1 upload/import contract](./I1-importer.md),
  [M1 provider settings contract](./M1-metadata-providers.md),
  [J1 maintenance contract](./J1-maintenance-jobs.md), and the merged
  `web/src/lib/api/`, catalog, navigation, localization, and test patterns

## Goal

Give administrators a bilingual, authenticated UI for the existing library and access
controls, import workflow, metadata-provider configuration, and maintenance jobs. All
mutations use the existing server APIs; the UI must not imply account-management or
authorization capabilities the backend does not provide.

## Scope

**Owns (create/modify freely):**
- `web/src/routes/admin/**`
- New admin API helpers, DTOs, components, and focused tests under `web/src/lib/admin/`
- Admin UI tests alongside owned source files

**Shared files (append-only, see plan §4):**
- `web/src/lib/nav.ts` — add an administrator navigation entry
- `web/src/routes/+layout.svelte` — show the admin entry only for an administrator;
  preserve the existing shell and auth behavior
- `web/messages/en.json` and `web/messages/zh.json` — add matching W5 keys only
- `web/package.json` / `web/pnpm-lock.yaml` — only if a required dependency is justified
- [progress/README.md](../progress/README.md) — edit only the W5 row and append a W5 log

**Must not touch:**
- `internal/**`, migrations, API contracts, or generated
  `web/src/lib/paraglide/**`
- Book metadata merge UI (`books/[id]/edit`, W6), stats/notes/export UI (W7), or
  unrelated catalog and reader behavior

## Requirements

1. Add an administrator-only `/admin` area with clear links or tabs for libraries/access,
   imports, providers, and maintenance. Check the authenticated viewer role using the
   existing session/API patterns. Non-admins must not see the admin navigation entry;
   direct visits and API `401`/`403` responses must be handled explicitly. Client-side
   checks are UX only; never treat them as authorization.
2. Provide library create, rename/slug edit, and delete controls using the existing
   `/api/v1/admin/libraries` routes and DTOs. Show duplicate-name/slug, nonempty-library,
   and default-library conflicts without discarding the form. Confirm deletion and
   communicate that deletion is rejected while books or the configured default-library
   reference remain.
3. Manage per-library grants through the existing access-list and grant/revoke routes.
   Render paged results, preserve returned cursors, and allow grant/revoke by a validated
   positive user ID. Admins have implicit library access; do not present grant rows as
   necessary for administrators. Manage a selected user's hidden books through the
   existing hide-list routes, with paged results and explicit hide/unhide confirmation.
   Hide controls accept a positive book ID and must not display hidden-book metadata.
4. **Known API gap:** there is no administrator user-list, account CRUD, or password-reset
   HTTP endpoint in the merged code. Do not invent or call one, and do not add backend
   routes in this web-only task. Use explicit positive user IDs for access and hide-list
   operations, explain that account creation/password reset remain CLI operations, and
   record the missing user-list/account-management API as a follow-up in the W5 hand-off.
5. Add an upload form using the existing administrator `POST /api/v1/uploads` multipart
   contract: choose a library and submit exactly one file per request. Use `FormData`
   with the browser-generated multipart boundary (not the JSON API client's body
   serializer). Surface the returned import job and its errors. List import history from
   `GET /api/v1/imports` with the server cursor and limit contract; support refresh and
   bounded polling while the page is open without overlapping requests or polling after
   navigation. Display the documented job statuses and safe error text; do not expose
   spool paths or infer internal failure details.
6. Configure providers using
   `GET /api/v1/admin/metadata/providers` and
   `PATCH /api/v1/admin/metadata/providers/{provider}`. Show enabled state, priority,
   base URL where supported, and whether a token is configured; never display or log a
   stored token. An omitted token preserves it and explicit `null` removes it. Make
   token removal deliberate, warn before disabling credential-dependent providers, and
   handle invalid base URLs, priority bounds, and provider errors without losing unsaved
   edits.
7. Show maintenance jobs from `GET /api/v1/admin/maintenance`, including schedule,
   current status, and last-run timestamps. Trigger supported jobs through the POST route,
   disable duplicate submissions while accepted/running, and refresh until completion.
   Surface `404`, `409`, `503`, and network errors explicitly. Do not display filesystem
   paths or promise persistent run history; status resets on server restart.
8. Use the existing typed API client for JSON routes, handle `ApiError` and network
   failures, and provide explicit loading, empty, retry, success, and validation states.
   Keep destructive actions confirmed, prevent stale responses from overwriting newer
   selections, and do not duplicate backend access rules in client-side filters.
9. Add natural English and Chinese messages for every new label, action, confirmation,
   loading/empty/error state, and status. Preserve keyboard access, semantic headings,
   focus-visible styles, responsive layouts, and accessible form labels.
10. Add focused Vitest coverage for request helpers and UI state (library conflicts,
    grant/hide selection, upload/job polling, provider token-preservation/removal, and
    maintenance conflicts) plus Playwright coverage for the principal admin workflows.
    Use existing tooling; do not modify backend behavior to make tests pass.

## Out of scope

- Account creation, password reset, or user enumeration over HTTP (no such admin API exists)
- Metadata candidate merge and PDF cover generation (W6)
- Stats, notes, and annotation export (W7)
- Backend or schema changes, access-control policy changes, and importer/maintenance logic

## Acceptance criteria

- [x] Administrators can manage libraries, grants, hide lists, uploads/import history,
  provider settings, and maintenance using the implemented APIs.
- [x] Account-management limitations are accurately disclosed; no undocumented endpoint is
  assumed or called.
- [x] Non-admin navigation and direct-route behavior are handled, while server
  authorization remains authoritative.
- [x] New UI is bilingual, keyboard accessible, and covers loading, empty, validation,
  conflict, and network-error states.
- [x] `pnpm --dir web check`, `pnpm --dir web test`, `pnpm --dir web build`, and focused
  Playwright tests pass.

## Validation commands

```powershell
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:e2e -- --workers=2
```

## Hand-off

- Update this prompt's status and W5's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record the user-ID workflow and missing account-management API as follow-ups; keep all
  API request and response shapes aligned with the referenced implementation hand-offs.
- Update architecture docs or add an ADR only if the accepted design changes.

### W5 hand-off notes (2026-11-04)

- Routes: `/admin` (overview + account CLI guidance), `/admin/libraries` (CRUD + access
  grants), `/admin/hidden-books`, `/admin/imports`, `/admin/providers`,
  `/admin/maintenance`. Shared code lives in `web/src/lib/admin/`. The Admin nav entry is
  shown only to `role === 'admin'` via `navigationFor(role)` in `web/src/lib/nav.ts`; the
  admin layout re-checks `/auth/me` and shows a forbidden state to other users. The server
  remains authoritative for every request.
- User-ID workflow: there is still no HTTP user-list or account-management API, so grants
  and hide lists take a numeric user ID (printed by `pandalibrary user create`). The
  overview page documents `pandalibrary user create` / `user reset-password`.
  **Follow-up:** add an administrator user-list/account API, then replace the ID inputs
  with a user picker.
- Hide lists show only `book_id`, `hidden_by`, and `created_at` (the API returns no book
  metadata, and fetching details could be refused for hidden books). **Follow-up:** an
  admin-visible title in the hide-list DTO would improve this.
- Uploads send `library_id` then one `file` as multipart via `fetch` + `FormData`. Import
  history uses I1 cursors; while any displayed job is pending/processing, a non-overlapping
  poller (3 s, at most 100 ticks per start) silently merges the newest page into the list.
- Provider tokens are never prefilled or echoed: the token field is write-only, an omitted
  `api_token` preserves the stored token, and removal sends explicit `null` after
  confirmation. Disabling a credentialed provider also asks for confirmation.
- Maintenance status is in-memory on the server; the page says so, disables Run while a
  job is accepted/running, treats 409 as "already running", and polls (2 s, ≤ 90 ticks).
- Errors are mapped to localized messages by status and action; server `detail` text is
  never displayed (except I1's sanitized import job `error`).
- Tests: `web/src/lib/admin/{api,form,jobs}.test.ts`, `web/src/lib/nav.test.ts`, and
  `web/src/routes/admin.e2e.ts` (7 browser tests). No architecture change or ADR.
