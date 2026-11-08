# BD3: Multi-user book reviews: storage, API, web client

- Status: Done
- Wave: 1. Dependencies merged: baseline (`d6014b0`)
- Can run in parallel with: BD1, BD2, BD4, BD5, BD6
- Branch/worktree: `task/bd3` in `..\pandalibrary-bd3`
- Migration: **yes**, `00007_book_reviews.sql` (number reserved). **Merge
  after BD2.** Rebase on it and re-run `task migrate:sum`.

## Read first

- [Book Detail plan](../plans/book-detail-plan.md): R12, decisions 11-12,
  the "Reviews API" contract (this task implements it **exactly**).
- Why not notes: `web/src/lib/bookview/details/details-data.ts`
  (`latestReview`). The reader creates book-level notes too
  (`routes/read/[bookId]/[fileId]/+page.svelte` `openNote(null)`), so notes
  are private and must never be exposed.
- Catalog patterns: `internal/catalog/service.go` (`ErrNotFound`,
  `ErrForbidden`, `Viewer`), `catalog/read.go` `GetBook` (visibility: library
  access and `book_hidden`), `catalog/pagination.go` (opaque cursors),
  `catalog/shelves.go` / `shelves_books.go` (service style) and their tests.
- HTTP patterns: `internal/httpapi/shelves.go` (`ShelfMount`,
  `catalogHTTP`, `withViewer`, `pathID`, `query`, `writeError`,
  `cookieProtection`) + `shelves_test.go`; mount list in
  `internal/app/app.go` (~line 210).
- Migrations: `00005_reading_statuses.sql`, `migrations_test.go`; sqlc
  config `sqlc.yaml`; `users` table (`display_name`, `username`).
- Web client patterns: `web/src/lib/catalog/api.ts` (`api.request`,
  signals), `web/src/lib/api/client.ts` (`ApiError`), and `catalog/api.test.ts`.

## Goal

Every user who can see a book can read all users' reviews of it, and can
write, edit and delete their own review. Admins can remove any review. The
web has a typed client, which BD7 uses for the Reviews card.

## Scope

**Owns:** `internal/db/migrations/00007_book_reviews.sql` (+ `migrations.sum`,
`migrations/reviews_test.go`), `internal/db/queries/reviews.sql` (new) + generated
sqlc, `internal/catalog/reviews.go` + `reviews_test.go` (new),
`internal/httpapi/reviews.go` + `reviews_test.go` (new), one
`httpapi.ReviewMount(...)` line in `internal/app/app.go`,
`web/src/lib/bookview/reviews-api.ts` + `reviews-api.test.ts` (new).

**Must not touch:** notes, the sync protocol, `details-data.ts`,
`ReviewEditor.svelte`, and every UI component (BD7).

## Subtasks

### BD3.1 – Schema

> `task migrate:new NAME=book_reviews`:
> ```sql
> CREATE TABLE book_reviews (
>     id         INTEGER PRIMARY KEY,
>     book_id    INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
>     user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
>     body       TEXT    NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 10000),
>     created_at INTEGER NOT NULL,
>     updated_at INTEGER NOT NULL,
>     UNIQUE (book_id, user_id)
> );
> CREATE INDEX book_reviews_book_updated ON book_reviews (book_id, updated_at DESC, id DESC);
> ```
> Down drops the table. Note that the SQLite `length` counts characters; the
> Go validation counts runes the same way. Run `task migrate:sum`, and add an
> up/down case to `migrations_test.go`.

### BD3.2 – Queries and service

> `reviews.sql`: list a page for a book (join `users` for
> `COALESCE(NULLIF(display_name,''), username)`), excluding the viewer's own
> row, keyset `(updated_at, id) <` cursor, `LIMIT :limit + 1`; get the
> viewer's own review; upsert own (`ON CONFLICT (book_id, user_id) DO UPDATE
> SET body, updated_at`); delete own; delete by id (admin); count reviews of
> a book. In `catalog/reviews.go`: `ListReviews(ctx, viewer, bookID,
> PageOptions) (ReviewPage, error)`, `SaveMyReview(ctx, viewer, bookID,
> body)`, `DeleteMyReview`, `DeleteReview(ctx, viewer, bookID, reviewID)`.
> Rules:
> - Every call first checks that the viewer can see the book (reuse the
>   `GetBook` visibility rule) → `ErrNotFound`.
> - The body is trimmed and must be 1-10,000 runes, else a validation error
>   (map it to 400 like the other catalog validation errors).
> - `DeleteReview` requires an admin (`ErrForbidden`) and a review of that
>   book (`ErrNotFound`).
> - `mine` is set per viewer.
> - Times come from the service clock (ms); `updated_at` changes only on an
>   update.
>
> `ReviewPage` = `{ Mine *Review; Items []Review; NextCursor *string; Total
> int }` (`total` is already in the plan contract). If you add any other
> field, **update the plan's contract** in `book-detail-plan.md` in the same
> commit.
> Service tests: visibility (no library access, hidden book), ordering and
> paging across equal `updated_at`, own row excluded from items,
> create-then-update keeps `created_at`, validation bounds (0, whitespace,
> 10,000, 10,001 runes, CJK), admin delete versus non-admin, and cascade when
> a user or book is deleted.

### BD3.3 – HTTP

> `httpapi/reviews.go` `ReviewMount(service, authentication, logger)`:
> `GET /api/v1/books/{id}/reviews` (query `limit` 1-50, default 20, and
> `cursor`; unknown params → 400 like the shelves handlers), `PUT
> /api/v1/books/{id}/reviews/me` (JSON `{ "body": string }`, unknown fields
> rejected, body limit respected), `DELETE /api/v1/books/{id}/reviews/me`,
> and `DELETE /api/v1/books/{id}/reviews/{reviewId}`. Writes use
> `cookieProtection`. Register it in `app.go`. HTTP tests: 401 without a
> session, 404 for an invisible book, 400s, 403 for a non-admin delete by id,
> the cross-site write rejected, and the JSON shape exactly per the contract
> (RFC3339 times).

### BD3.4 – Web client

> `reviews-api.ts`: types `Review`, `ReviewAuthor`, `ReviewPage` and
> functions `listReviews(bookId, { cursor?, limit?, signal? })`,
> `saveMyReview(bookId, body)`, `deleteMyReview(bookId)` and
> `deleteReview(bookId, reviewId)`. Validate positive integer IDs
> (`RangeError`) and the body length client-side, and encode the cursor.
> Vitest with a mocked `api.request`: paths, methods, bodies, signal
> pass-through and error propagation.

## Acceptance criteria

- [x] The API matches the plan contract (or the plan is updated in the same
      commit).
- [x] No private data leaks: notes are untouched, and reviews respect book
      visibility for both reading and writing.
- [x] Go service/HTTP/migration tests and the web client tests pass.
      `task sqlc:check` is clean.

## Validation commands (targeted only)

```powershell
task sqlc:check
go test ./internal/db/... ./internal/catalog/... ./internal/httpapi/... ./internal/app/...
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview/reviews-api.test.ts
```

## Hand-off

Implemented 2026-11-08 with migration **00007**, after BD2's **00006**.
No note data or UI components were changed.

Final JSON contract for BD7:

```ts
type ReviewAuthor = { id: number; display_name: string };
type Review = {
  id: number;
  book_id: number;
  author: ReviewAuthor;
  body: string;
  created_at: string; // RFC3339, UTC
  updated_at: string; // RFC3339, UTC
  mine: boolean;
};
type ReviewPage = {
  mine: Review | null;
  items: Review[];
  next_cursor: string | null;
  total: number;
};
```

`items` excludes the viewer's review and sorts by `updated_at DESC, id DESC`.
`total` includes the viewer's review. Cursors are bound to the book and viewer.
`PUT` returns `{ review: Review }`; both successful deletes return empty `204`
responses, now supported by the shared API client. Missing reviews return `404`.

Exports from `web/src/lib/bookview/reviews-api.ts`:

```ts
listReviews(bookId: number, options?: {
  cursor?: string | null; limit?: number; signal?: AbortSignal;
}): Promise<ReviewPage>;
saveMyReview(bookId: number, body: string): Promise<Review>;
deleteMyReview(bookId: number): Promise<void>;
deleteReview(bookId: number, reviewId: number): Promise<void>;
```

IDs must be positive safe integers. Page limits are 1-50, default 20.
Bodies are trimmed and validated as 1-10,000 Unicode code points; NUL
characters are rejected to avoid SQLite's NUL-terminated text-length behavior.
These validation failures raise `RangeError` in the client and HTTP `400` on
the server. Request failures propagate unchanged.

Verified: `task sqlc:check`, the targeted Go packages above, targeted Go vet,
`pnpm --dir web check` (zero errors/warnings), and the reviews API plus shared
API client Vitest tests (11 passed).
