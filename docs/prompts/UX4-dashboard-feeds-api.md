# UX4: Account-scoped dashboard book feeds

- Status: Ready
- Wave: 2; dependencies merged: UX2; migration: no
- Branch/worktree: `task/ux4` / `..\pandalibrary-ux4`

## Read first and ownership

Read [the plan](../plans/sidebar-dashboard-plan.md), UX2's contract,
catalog `read.go`/hydration/visibility/pagination helpers, reading tables,
and existing stats/HTTP tests. Own new `internal/catalog/dashboard*.go`,
`internal/httpapi/dashboard*.go`, and
`internal/db/queries/dashboard.sql`/generated counterpart. Add only a
localized DashboardMount line in `internal/app/app.go`.
No migration/models, reading/sync changes, shelf implementation changes, web,
build files, or unrelated catalog refactors.

## Implement

1. Add session-authenticated
   `GET /api/v1/dashboard/sections/{section}/books?limit=&cursor=`.
   Supported built-ins: `continue_reading`, `recently_added`, `read`, `unread`,
   `want_to_read`. Return the existing fully hydrated `Page<Book>` contract;
   no new incompatible card DTO. Default limit 20, maximum 100.
2. Implement the plan's exact default-feed predicates and descending timestamp
   orders with deterministic ID tie-breakers. Unread includes absent user_book
   rows or status unread, ordered title/ID; Want to Read uses that exact status,
   ordered user_book updated_at/ID descending.
3. Query/filter/page in SQL before hydration. Preserve existing library grants,
   user hide lists, and requester-scoped reading data. Joining another user's
   progress/status must never affect results. Do not issue one state HTTP call
   per book or enumerate the whole catalog to calculate a page.
4. Scope opaque cursors to viewer, section, filter/sort identity and tie-break
   values; reject malformed/mismatched cursors and unsupported sections with
   repository-standard problem responses. Specify live-update pagination
   semantics so a reordered row does not silently break the contract.
5. Reuse existing shelf endpoints for dashboard shelf sections; do not invent
   a second automatic-rule evaluator. Preferences remain the existing
   `user_settings` sync contract, key `dashboard.layout.v1`; no new preferences
   API/schema or default-reset behavior is needed here.
6. Return real empty arrays, report database errors rather than empty success,
   and use existing authenticated mounts/logger/error patterns.

## Acceptance and validation

Add SQL/service/HTTP tests with multiple accounts/libraries, hidden books,
absent/zero/complete progress, finished/abandoned states, creation vs update
timestamps, null finished_at fallback, tied ordering, full paging, unsupported
sections, invalid limits/cursors, and authentication failures.
Run focused tests, sqlc generation/check, Go build/lint/tests.
Document exact DTO/route, ordering and cursor examples in this hand-off for
UX5, and update your progress row/log.
