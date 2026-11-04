# UX2: System shelves and automatic shelf rules API

- Status: Ready
- Wave: 1; dependencies: baseline `05326ce`; migration: yes (sole writer)
- Branch/worktree: `task/ux2` / `..\pandalibrary-ux2`

## Read first

Read [the plan](../plans/sidebar-dashboard-plan.md), migration rules,
SH1's hand-off, `internal/catalog/shelves*.go`,
`internal/httpapi/shelves.go`, `internal/db/queries/shelves.sql`, and OPDS
shelf consumers. Existing `kind` means private/shared, NOT manual/automatic.

## Owns

Shelf-specific catalog/HTTP files/tests, shelf SQL/generated queries, one new
migration/checksum/generated models, and shelf DTO additions. Add isolated
catalog helper files if needed; preserve unrelated catalog behavior.
Document decisions in `architecture/ux2-shelves.md` and this hand-off.
No web source, auth, dashboard, or build files.

## Implement and freeze these contracts

1. Keep all existing private/shared CRUD and manual membership APIs compatible.
   Add `mode: "manual"|"automatic"`, `system_key: null|"favorites"`, and
   `rules: null|RuleSet` to numeric shelf DTOs. Missing mode on creation means
   manual. Existing rows migrate to manual. Automatic shelves are private in
   this iteration; reject unsupported shared automatic creation explicitly.
2. Add a stable Favorites shelf per viewer, provisioned transactionally and
   idempotently for old/new accounts without editing auth code. An ensure
   operation before the first authenticated shelf read is acceptable; never
   write on a read-only connection. Do not rename or absorb an existing custom
   shelf merely because its name is Favorites. Use stable system identity and
   distinguish custom-name collisions without data loss.
3. Keep Favorites in the normal numeric shelf list and membership API, protected
   against rename/delete/mode/rule changes. Add:
   `GET /api/v1/shelves/system/{key}` and
   `GET /api/v1/shelves/system/{key}/books`, with key `unshelved|favorites`.
   Metadata envelope: `{shelf:{key,name,mode,visible_book_count,shelf_id}}`;
   `shelf_id` is null for virtual Unshelved and numeric for Favorites.
   Books use the normal `Page<Book>`. Literal system routes must not be
   mistaken for numeric IDs. Unsupported keys get a problem response.
4. Unshelved is computed according to the plan's precise per-viewer definition.
   It has no fabricated database ID and rejects mutations. Counts, paging,
   existing hidden-book ACLs, and default/shared OPDS behavior stay consistent.
5. RuleSet JSON is `{match:"all"|"any",conditions:[...]}`, 1-20 conditions,
   flat only. Supported conditions: `{field:"title",op:"contains",value:string}`,
   or `op:"eq"` with `author_id|tag_id|series_id` (positive integer),
   `language|format|reading_status` (validated string/enum).
   Document case/substring and absent-field semantics. Reject empty strings,
   excessive lengths, unknown fields/operators, invalid enums, nesting, raw
   SQL/regex, malformed bodies, and rule changes on manual/system shelves.
6. Evaluate automatic membership live in parameterized SQL with existing
   visibility constraints; do not download all books to filter in Go or JS.
   Data/import/status changes must appear on the next read, without a cron
   rebuild. Keep counts and pages consistent. Existing numeric shelf-book GET
   works for both modes; automatic PUT/DELETE membership returns an explicit
   conflict. Preserve manual ordering; use deterministic title/ID ordering for
   automatic and Unshelved results.
7. Permit mode selection on creation; reject later mode conversion in this
   iteration so existing memberships are never silently discarded. Support
   changing an automatic shelf's rules through PATCH. Scope cursors to viewer,
   shelf, mode/rules and sort so stale or cross-account cursors cannot mispage.
8. Preserve library grants/hide behavior on every path including counts, rule
   validation, media links, and OPDS. Avoid a special-case privileged bypass
   that exposes another account's Favorites.

## Acceptance and validation

- Upgrade preserves custom shelves/order and provisions defaults exactly once,
  including parallel requests and custom names matching localized defaults.
- Tests cover manual regression, owner/shared/admin permissions, system
  protection, all/any rules, dynamic metadata/status changes, invalid/injection
  inputs, tied sort keys, pagination/cursor changes, and hidden-book counts.
- Run focused catalog/shelf/HTTP/OPDS tests, migration upgrade/down/checksum
  tests, `task sqlc:check`, `task build`, `task lint`, and `task test`.
- Record DTO/request/response examples, errors, cursor behavior, migration
  version, and exact results. UX3/UX4/UX6 must consume the merged contract.
