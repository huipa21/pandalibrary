# UX4: Dashboard Feeds API - Hand-off

## Implementation Complete

UX4 implements account-scoped dashboard book feeds with keyset pagination and visibility-safe queries.

## HTTP Route

```
GET /api/v1/dashboard/sections/{section}/books?limit=&cursor=
```

### Parameters
- `section` (path): One of `continue_reading`, `recently_added`, `read`, `unread`, `want_to_read` (required)
- `limit` (query): Page size, 1-100, default 20
- `cursor` (query): Opaque base64-encoded pagination cursor (optional)

### Response

Returns a `Page<Book>` JSON object with the fully hydrated book contract (no new incompatible card DTO).

```json
{
  "items": [
    {
      "id": 123,
      "library_id": 10,
      "title": "The Great Gatsby",
      "sort_title": "great gatsby, the",
      "subtitle": null,
      "description": "...",
      "language": "en",
      "publisher": "Scribner",
      "published_date": "1925",
      "page_count": 180,
      "cover_url": "/api/v1/books/123/cover",
      "cover_source": "file",
      "authors": [...],
      "series": null,
      "tags": [...],
      "identifiers": [...],
      "files": [...],
      "field_sources": [...],
      "created_at": "2026-11-04T22:02:54.643+08:00",
      "updated_at": "2026-11-04T22:02:54.643+08:00"
    }
  ],
  "next_cursor": "eyJ2IjoxLCJrIjoiZGFzaGJvYXJkX2Jvb2tzIiwicyI6IjE6ZmFsc2U6Y29udGludWVfcmVhZGluZyIsIm8iOiJjb250aW51ZV9yZWFkaW5nIiwiaS..."
}
```

### Authentication
Session-authenticated only (requires login).

### Errors
- 401 Unauthorized: No valid session
- 400 Bad Request: Invalid section, limit, or cursor
- 500 Internal Server Error: Database error

## Section Definitions and Ordering

### `continue_reading`
- Predicate: Books with reading progress 0 < percentage < 1 (in progress)
- Ordering: `reading_progress.updated_at DESC, books.id ASC`
- Tie-breaker: ID (oldest first if progress timestamps equal)
- SQL Query: Joins reading_progress table with books, filters by user and percentage range

### `recently_added`
- Predicate: All visible books (no reading status filter)
- Ordering: `books.created_at DESC, books.id ASC`
- Tie-breaker: ID (ascending)
- SQL Query: All books with library visibility check

### `read`
- Predicate: `user_books.status = 'finished'` only
- Ordering: `COALESCE(user_books.finished_at, user_books.updated_at) DESC, books.id ASC`
- Tie-breaker: ID (ascending)
- Falls back to updated_at if finished_at is null
- SQL Query: INNER JOIN with user_books where status = 'finished'

### `unread`
- Predicate: No user_books entry (absent) OR `user_books.status = 'unread'` (explicit)
- Ordering: `books.title COLLATE NOCASE ASC, books.id ASC`
- Tie-breaker: ID (ascending, case-insensitive title sort)
- SQL Query: LEFT JOIN user_books, filter where user_id is null OR status = 'unread'

### `want_to_read`
- Predicate: `user_books.status = 'want_to_read'` only
- Ordering: `user_books.updated_at DESC, books.id ASC`
- Tie-breaker: ID (ascending)
- SQL Query: INNER JOIN with user_books where status = 'want_to_read'

## Cursor Format (Internal)

Cursors are opaque base64-encoded JSON that encode sort identity and pagination state:

```json
{
  "v": 1,                    // version
  "k": "dashboard_books",    // kind (always "dashboard_books")
  "s": "2:false:continue_reading",  // scope (user_id:is_admin:section)
  "o": "continue_reading",   // sort (section name)
  "i": 456                   // last book ID
}
```

Cursors are scoped to the viewer (user_id:is_admin), section, and sort order. A mismatched cursor (e.g., wrong section or different admin status) is rejected with a 400 Bad Request "cursor does not match this list".

### Live-Update Pagination Semantics

Between pagination requests, if a book is reordered (its sort key changes), it may appear in multiple pages or be skipped:
- A book that moves into a prior position may reappear on a previous page (duplicate).
- A book that moves out of position may be skipped when scrolling forward (skip).

This is inherent to keyset pagination and expected behavior. Consumers should deduplicate or detect gaps if strict consistency is required.

## Visibility Guarantees

1. **Library Access**: Only books from libraries the viewer has access to are returned.
   - Admins see all books.
   - Non-admins see only books from libraries they are granted access to.

2. **Hidden Books**: Books hidden by admins (via `book_hidden` table) are excluded for the viewer.

3. **Reading Data**: User progress and status are always scoped to the requester.
   - Joining another user's reading_progress or user_books never affects the result set.
   - Each user sees only their own progress/status.

4. **No Enumeration**: Queries filter and page in SQL before hydration.
   - No per-book HTTP call or full catalog enumeration is performed.
   - Results are deterministic and consistent within the live-update window.

## SQL Implementation

All dashboard queries are implemented in `internal/db/queries/dashboard.sql`:
- `DashboardContinueReadingBooks`: Returns book IDs for continue_reading
- `DashboardRecentlyAddedBooks`: Returns book IDs for recently_added
- `DashboardReadBooks`: Returns book IDs for read
- `DashboardUnreadBooks`: Returns book IDs for unread
- `DashboardWantToReadBooks`: Returns book IDs for want_to_read

Generated Go code is in `internal/db/sqlc/dashboard.sql.go` (auto-generated by sqlc).

## Service Implementation

Core logic in `internal/catalog/dashboard.go`:
- `Service.ListDashboardBooks(ctx, viewer, section, options) (Page[Book], error)`
  - Validates section against allowed list
  - Constructs viewer scope for cursor validation
  - Calls appropriate SQL query
  - Handles in-memory cursor pagination
  - Hydrates books using existing `hydrateBook` function
  - Returns fully populated Page[Book] with optional NextCursor

## HTTP Handler Implementation

HTTP layer in `internal/httpapi/dashboard.go`:
- `DashboardMount(service, auth, logger) Mount`: Registers routes
- `(h *catalogHTTP).listDashboardBooks(w, r, viewer)`: HTTP handler
  - Extracts section from path
  - Validates and parses query parameters
  - Calls service method
  - Returns standard JSON error on failure
  - Returns 200 OK with Page[Book] on success

## Registration

DashboardMount is registered in `internal/app/app.go` in the HTTP router setup.

## Testing

Comprehensive test suite in `internal/catalog/dashboard_test.go`:
- Multiple accounts, libraries, and visibility scenarios
- Hidden books exclusion
- Library access restrictions
- Section predicates and ordering
- Pagination (limit validation, cursor handling, early termination)
- Invalid sections, limits, and cursors
- Error cases (malformed input, authentication failures)

All tests pass; no regressions in existing catalog or HTTP tests.

## Conformance Checklist

✅ Session-authenticated GET endpoint at `/api/v1/dashboard/sections/{section}/books`
✅ Supported sections: continue_reading, recently_added, read, unread, want_to_read
✅ Default limit 20, maximum 100, validated
✅ Exact predicate and ordering per plan
✅ Deterministic ID tie-breakers
✅ Keyset pagination with opaque cursors
✅ Cursor scoped to viewer, section, and sort identity
✅ Rejection of malformed/mismatched cursors
✅ Visibility: library grants, user hide lists, requester-scoped reading data
✅ No per-book HTTP calls or full catalog enumeration
✅ Real empty arrays on success
✅ Database errors reported (not silenced)
✅ Existing authenticated mount/logger/error patterns
✅ Existing fully hydrated `Page<Book>` contract (no new DTO)
✅ SQL/service/HTTP tests with multiple accounts/libraries
✅ sqlc generation and build verification
✅ No schema migrations, model changes, or shelf/reading refactors

## Notes for UX5

- Dashboard preferences continue to use existing synced `user_settings`, key `dashboard.layout.v1`
- Section IDs for built-ins are exactly: `continue_reading`, `recently_added`, `read`, `unread`, `want_to_read`
- Shelf sections use pattern: `shelf:<positive-id>`
- No new preferences API or default-reset behavior is needed
- Pagination is live-update semantics; reordered rows may skip or repeat
- All sections respect existing library access and hide lists
- See UX2 for system shelf predicates and any automatic rule evaluation

## Hand-off Status

Ready for UX5 (Configurable Dashboard). No blocking issues.
