# ST1: Stats API

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § ST1
- Depends on (merged): R1
- Can run in parallel with: E1, O1, W4
- Branch / worktree: `task/st1` in `..\pandalibrary-st1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 5–6, 8, 12
- [architecture/database.md](../architecture/database.md) §§1–3, 5–6
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md), and
  [R1's reading-session and visibility contracts](./R1-reading-sync-api.md)
- `internal/db/migrations/00001_init.sql`, the generated sqlc package,
  `internal/reading/`, `internal/httpapi/reading.go`, and the current `Mount` wiring

## Goal

Expose authenticated reading statistics from the existing `reading_sessions` and
`user_books` data. Aggregate reading activity into calendar days using an explicitly
validated IANA timezone, correctly handling daylight-saving transitions, and apply the
current book-visibility rule to every book-derived aggregate.

## Scope

**Owns (create/modify freely):**
- `internal/stats/**`
- `internal/db/queries/stats.sql` and generated sqlc output from `task sqlc`
- Stats HTTP handler and tests under `internal/httpapi/`
- Stats-specific tests in the owned packages

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — construct the stats service and append its mount
- `go.mod` / `go.sum` — only if a directly required dependency is missing
- [progress/README.md](../progress/README.md) — edit only the ST1 row and append an ST1 log

**Must not touch:**
- `internal/db/migrations/**`, `internal/reading/**`, or existing reading/sync behavior
- `internal/catalog/**`, existing visibility rules, or the importer
- Frontend stats UI (W7) or other Step 9 task implementations

## Requirements

1. Add authenticated `GET /api/v1/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&timezone=Area/Location`.
   All three parameters are required, must occur exactly once, and must be valid; reject
   malformed dates, unknown IANA zones, reversed ranges, and ranges longer than 366
   inclusive calendar days with 400. Load zones with `time.LoadLocation`; do not rely on
   host-installed zoneinfo. Use the existing session middleware, `ViewerFromRequest`,
   `httpapi.Mount`, and problem-response conventions.
2. Interpret `from` and `to` as inclusive local calendar dates in the supplied timezone.
   Convert local midnight boundaries to UTC instants using the loaded location (not a
   fixed 24-hour duration), so DST-short and DST-long days are correct. Attribute each
   session's `active_seconds` to the local date of its `started_at`; do not attempt to
   divide active time across days because the schema stores only a session total.
3. Return a documented stable JSON DTO containing:
   - `timezone`, `from`, and `to`;
   - `daily`: one item for every requested local date, including zero-activity days, with
     `date`, `active_seconds`, and `session_count`;
   - `finished_per_month`: months intersecting the requested range with visible books
     whose current `user_books.status` is `finished` and whose `finished_at` falls in range;
   - `streaks`: `current_days` and `longest_days`, calculated from distinct local dates
     with positive active reading time through `to` and the viewer's available history;
   - `time_per_book`: visible books with activity in range, including `book_id`, `title`,
     ordered author names, `active_seconds`, and `session_count`.
   Keep arrays deterministic, use UTC RFC 3339 only for timestamps (date and month
   buckets are ISO calendar strings), and return empty arrays rather than null.
4. Scope sessions and finished-book rows to the authenticated user. Join every book-derived
   query through the exact access-plus-hide predicate in
   [database.md](../architecture/database.md) §5; hidden books remain excluded even for an
   admin. Do not expose hidden book IDs, counts, or metadata through aggregates.
5. Keep query work bounded and use the read pool and sqlc conventions. Do not fetch an
   unbounded list of sessions into Go; aggregate durations/counts in SQL where possible and
   perform only timezone/calendar bucketing in Go. Keep range and result sizes bounded;
   never add a migration or accept a user ID from request data.
6. Add real-SQLite service tests and HTTP tests for timezone parsing, inclusive date
   boundaries, zero-filled days, finished-month buckets, streaks, visibility for regular
   users and admins, malformed/duplicate parameters, and canceled/database-error paths.
   Include a DST transition test that proves consecutive local midnights do not assume
   24-hour UTC intervals.

## Out of scope

- Stats charts, controls, or frontend navigation (W7)
- Notes/highlights export (E1)
- Reading-session write or sync changes (R1)
- Schema migrations or new persisted timezone settings

## Acceptance criteria

- [x] The authenticated stats endpoint returns the documented, bounded DTO.
- [x] Local-day grouping uses IANA timezone transitions and has a DST regression test.
- [x] Session and finished-book aggregates never include hidden or inaccessible books.
- [x] Query parameters, limits, and error responses are tested.
- [x] `task sqlc:check`, `task build`, `task lint`, and `task test` pass.

## Validation commands

```powershell
task sqlc
task sqlc:check
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and ST1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Keep the timezone and response contract below stable for W7; update architecture docs
  or add an ADR only if the accepted design changes.

## Implementation hand-off

- `GET /api/v1/stats?from=2026-01-01&to=2026-01-31&timezone=Asia/Shanghai` returns
  `{"timezone":"Asia/Shanghai","from":"2026-01-01","to":"2026-01-31","daily":[{"date":"2026-01-01","active_seconds":0,"session_count":0}],"finished_per_month":[{"month":"2026-01","books_finished":2}],"streaks":{"current_days":3,"longest_days":8},"time_per_book":[{"book_id":42,"title":"...","authors":["..."],"active_seconds":3600,"session_count":2}]}`.
- Date ranges are inclusive local dates; the browser/W7 supplies its IANA timezone.
  Sessions are bucketed by local `started_at` date. Current streak is measured backward
  from `to` (zero if there is no activity on `to`); longest streak uses all visible
  reading history through `to`. Ties/order for per-book results are active seconds
  descending, then book ID ascending.
- `daily` always contains every requested date; `finished_per_month` contains every
  intersecting month (including zero counts), with counts restricted to the requested
  date range rather than the whole month. Both arrays are ordered ascending.
  `authors` contains only `role='author'` names, ordered by catalog position then author
  ID. All arrays, including a book's authors, encode as `[]`, never `null`, when empty.
- Dates must be canonical `YYYY-MM-DD` in years 0001–9999, and the inclusive range
  contains at most 366 dates. `UTC` and IANA aliases are accepted; `Local`, unknown zones,
  empty/duplicate/malformed parameters, and extra keys (including user IDs/admin flags)
  receive 400. Zone data is bundled using `time/tzdata`; the host need not supply it.
- Local boundaries handle 23/25-hour days, skipped/repeated midnight, and skipped
  calendar dates. A skipped date has a zero-length interval and a zero-filled bucket.
  Zero-second sessions count as sessions but do not contribute to streaks.
- Range results are limited to 1000 visible books. A range exceeding that limit receives
  400 with a request to narrow the range; results are never silently truncated.
  The service uses a single query-only read transaction with a 10-second deadline.
  Durations, counts, distinct history dates, and streak islands are aggregated in SQL;
  no individual sessions are returned to Go. Go supplies calendar boundaries and
  bounded offset intervals between the first and last positive visible session through
  `to` (at most 20,000 intervals). Database failures, cancellations, timeouts, and
  excessive history complexity are logged and receive the standard 500 problem response.
- Regression coverage includes spring/fall DST, midnight gaps/overlaps, the Apia skipped
  date, fractional and historical seconds-resolution offsets, leap-year timezone
  intervals, out-of-range history, current finished status, ownership, regular/admin
  visibility, book limits, integer-overflow/database failures, and HTTP validation.
