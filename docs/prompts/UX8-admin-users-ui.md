# UX8: Admin users panel and account selectors

- Status: Ready
- Wave: 2; dependencies merged: UX7; migration: no
- Branch/worktree: `task/ux8` / `..\pandalibrary-ux8`

## Read first and ownership

Read [the plan](../plans/sidebar-dashboard-plan.md), UX7 DTO/error hand-off,
W5's known API gap, admin layout/pages/helpers, library access and hide lists.
Own `/admin/users/**`, admin tab/overview additions,
new `web/src/lib/admin/users/**`, necessary account-selector changes in
admin libraries/hidden-books pages, related tests, and `ux8.*` messages.
Do not edit backend, root shell, shelves, dashboard, reader, or build files.

## Implement

1. Add Users tab and overview link under `/admin`, not HOME or public
   navigation. Non-admins cannot see the controls; direct visits and 401/403
   are handled explicitly. Server authorization remains authoritative.
2. Render paged users with username/display name, role, locale, enabled state,
   and readable dates. Provide create/edit forms for UX7's actual fields.
   Preserve values on validation/conflict/network errors and avoid duplicate
   or stale async updates. Do not invent endpoints or client-only success.
3. Add enable/disable, confirmed deletion, password reset with confirmation,
   and credential/session revocation controls. Explain data/credential effects;
   deletion must clearly distinguish private reading data from shared books.
   Respect last-admin/self-action conflicts from the server. After self-reset
   or self-revoke, clear/retire the existing account state using existing
   session/offline invalidation patterns and direct the user to login.
4. Password inputs use appropriate autocomplete, never prepopulate or echo a
   stored password/hash, and clear sensitive values after success/cancellation.
   Do not log request bodies or persist temporary passwords in client storage.
5. Replace the old "CLI only/no user API" advice with working account controls.
   Use a reusable paged user selector for library grants and user hide lists,
   rendering human-readable identity while submitting the numeric ID.
   Retain explicit API errors and implicit admin-library access rules;
   do not eagerly enumerate all accounts just to fill a dropdown.
6. Match the app/admin visual style and provide both locales, keyboard/form/
   dialog focus behavior, loading, no users, retry, success and conflict states.

## Acceptance and validation

Focused typed API/form/selector tests and real-server browser tests cover
create/edit/disable/re-enable/delete, password reset/login, revoked sessions,
last-admin rejection, non-admin direct access, grants/hide user selection and
both locales. Existing admin imports/providers/maintenance still work.
Run frontend check, focused units/browser tests and build. Remove stale gap
wording only from current UI/docs; keep historical W5 hand-off as history.
Update prompt/progress and record exact results.
