# C1: Catalog core

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § C1
- Depends on (merged): A1, including its F4 and F2/F3 dependencies
- Can run in parallel with: none — serial gate
- Branch / worktree: `master` (current worktree)
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3–7, 15
- [architecture/database.md](../architecture/database.md) §§1–5, 7–9
- [architecture/migrations.md](../architecture/migrations.md) §§1–2
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0003](../decisions/0003-auto-applied-migrations.md), and
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- The merged A1 auth service and `internal/httpapi/auth.go`, F4 router and app wiring,
  F2 database and sqlc APIs, and X1 `internal/covers/covers.go`
- `internal/db/migrations/00001_init.sql`, `internal/db/queries/`, and the generated
  `internal/db/sqlc` package

F2 and X1 code is present on master, but their board rows are still `Review`. Check their
recorded follow-ups during review; do not silently mark either task done as part of C1.

## Goal

Provide the authenticated catalog foundation used by the library UI, importer, search,
reading, and protocol adapters. Administrators can manage libraries, access, hide lists,
and book metadata; viewers can browse only authorized books and retrieve their files and
covers. Keep the visibility rule reusable and testable, and keep the search index current
when catalog metadata changes.

## Scope

**Owns (create/modify freely):**
- `internal/catalog/**` and its visibility test harness
- `internal/blobstore/**` for content-addressed layout and the read side
- `internal/search/index.go` and its focused tests, for `IndexBook` only
- `internal/db/queries/catalog.sql` and catalog-specific HTTP handlers and tests

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — construct and mount the catalog service using the existing
  database pools, data directory, auth service, and logger
- `internal/httpapi/routes.go` — preserve the existing mount convention; register
  catalog through a `Mount` callback rather than restructuring the router
- `internal/db/sqlc/**` — generated output from catalog queries; run `task sqlc`
- `go.mod` / `go.sum` — add only dependencies needed for C1, such as pinyin conversion
- [progress/README.md](../progress/README.md) — edit only the C1 row and append a C1 log

**Must not touch:**
- `internal/db/migrations/**`, other domains' query files, or generated code by hand
- `internal/auth/**` and existing auth, health, SPA, and middleware behavior
- `web/**`, importer, reading, search-query, shelves, OPDS, and KOReader implementations
- The general book-blob write/import pipeline, owned by I1

## Requirements

1. Use the existing F2 writer/reader pools and sqlc conventions. Services own writes and
   transactions; HTTP handlers call services, not sqlc. Mount routes using F4's
   `httpapi.Mount`, A1's `SessionMiddleware`, `ViewerFromRequest`, `RequireRole`, and the
   supplied cookie-protection middleware. Derive a domain viewer's user ID and admin flag
   from the authenticated `auth.User`; never accept either from a client. All unsafe
   session-authenticated requests require cookie-origin protection. Preserve existing
   routes and middleware behavior.
2. Apply the exact predicate from database.md §5 to **every book-derived catalog read**:
   library access is granted by a matching `library_access` row unless the viewer is an
   admin, and a matching `book_hidden` row for that viewer always excludes the book,
   including for an admin. Apply it to book lists and details, filtered lists, related
   authors/series/tags and counts, file and cover reads, and book mutations' target
   lookup. Return 404 for both inaccessible and nonexistent books. Library browsing may
   include an accessible empty library; author/series/tag lists and details must not
   reveal entities associated only with invisible books.

   Admin-only access and hide-list management reads are ACL configuration, not book
   browsing: return the target IDs and grant/hide metadata needed to manage them, but no
   book metadata. In particular, an admin must be able to remove their own hide entry
   without creating a bypass for book content or other catalog reads.
3. Implement these authenticated read APIs under `/api/v1`. List responses use
   `{ "items": [...], "next_cursor": "..." | null }`; single-resource responses use a
   named object such as `{ "book": {...} }`. Document exported DTOs and their JSON fields
   in code, including nullable fields. Encode timestamps as UTC RFC 3339 strings, as
   the existing auth API does.
   - `GET /libraries` and `GET /libraries/{id}` return accessible library IDs, names,
     slugs, and creation/update timestamps.
   - `GET /books` supports `library_id`, `author_id`, `series_id`, and `tag_id` filters
     and `sort=title|added|series`. Default to title; require `series_id` for series
     order. Title sorts by `(sort_title, id)` ascending; added sorts by
     `(created_at, id)` descending; series sorts by index ascending with nulls last and
     ID as a tie-breaker. `GET /books/{id}` returns the book and its visible metadata.
   - `GET /authors`, `/series`, and `/tags`, and their `/{id}` detail routes, return
     IDs, names, and visible-book counts. A book filter on `/books` supplies each entity's
     book list. Order entity lists deterministically with ID as a tie-breaker.
   - Book DTOs include IDs, library ID, title, sort title, nullable bibliographic fields,
     ordered authors with roles, optional series and decimal index, tags, identifiers,
     and file IDs/formats/sizes plus a hash-versioned download URL as described below.
     Detail DTOs also expose field-source information needed by later metadata UI. Never
     expose storage paths, password data, or another user's reading data.

   Use keyset pagination for every list: default `limit=50`, maximum 100, a stable
   sort-key-plus-ID cursor, and a null next cursor at the end. Include the null/non-null
   partition in series-order cursors. Bind opaque cursors to their sort and filters;
   reject invalid limits, filters, and mismatched or malformed cursors with 400. Pages
   over unchanged data must not skip or repeat rows when sort values tie.
4. Provide administrator-only library and ACL APIs, with JSON bodies and responses:
   - `GET /admin/libraries`, `POST /admin/libraries` with
     `{ "name": "Comics", "slug": "comics" }`, `PATCH /admin/libraries/{id}`, and
     `DELETE /admin/libraries/{id}`. PATCH accepts either or both name and slug. Create
     returns 201 with `{ "library": ... }`, patch returns 200 with the same shape, and
     delete returns 200 with `{ "deleted": true }`. Validate names and folder-safe
     lowercase slugs against the schema; return 409 for duplicates and for deleting a
     library that still has books. Do not leave a configured
     `server_settings.default_library_id` dangling: reject its deletion with 409 until
     the default is reconfigured.
   - `GET /admin/libraries/{id}/access` lists entries with `user_id` and `granted_at`;
     `PUT` and `DELETE /admin/libraries/{id}/access/{user_id}` grant and revoke access.
   - `GET /admin/users/{user_id}/hidden-books` lists entries with `book_id`, nullable
     `hidden_by`, and `created_at`; `PUT` and
     `DELETE /admin/users/{user_id}/hidden-books/{book_id}` add and remove entries.

   Paginate these lists with the same envelope and limits. Grant/hide operations are
   idempotent for existing resources and return 200 with `{ "granted": true }`,
   `{ "revoked": true }`, `{ "hidden": true }`, or `{ "hidden": false }`, respectively;
   reject nonexistent referenced resources with 404. Record the authenticated admin as
   `hidden_by`. Admins implicitly have library access; grant rows are for regular users.
   A regular user must receive 403 for all of these operations. Return JSON rather than
   empty 204 responses so the existing web API client's JSON decoder can consume them.
5. Implement admin-only `PATCH /books/{id}` and `DELETE /books/{id}`. PATCH is partial:
   absent fields are unchanged; null clears nullable fields; supplied arrays replace the
   corresponding associations. Accept `library_id`, `title`, `subtitle`, `description`,
   `language`, `publisher`, `published_date`, `page_count`, `series`, `authors`, `tags`,
   and `identifiers`. Use `{ "name": "Series name", "index": 1.5 }` or null for series
   (the index may itself be null), ordered `{ "name": "Author name", "role": "author" }`
   author objects, tag-name strings, and `{ "scheme": "isbn13", "value": "..." }`
   identifier objects. Validate roles, identifier schemes, dates, positive page counts,
   nonnegative finite series indices, duplicate associations, and nonempty names/title;
   reject unknown fields and invalid input without partial writes.

   Reuse case-insensitively deduplicated authors, series, and tags according to the
   schema; do not rename a global entity merely by linking it to a book. In one writer
   transaction, update the book, links, `updated_at`, and `book_field_sources` for edited
   fields (`source=manual`, `chosen_by` the viewer), and reindex affected text. A
   `library_id` change has no field-source row. Clean up newly orphaned authors without
   deleting an author still linked to another book. PATCH returns 200 with `{ "book": ... }`.
   DELETE returns 200 with `{ "deleted": true }`. In the same transaction, remove the
   book's `books_fts` row and the `highlights_fts`/`notes_fts` rows for annotations
   deleted by the book or highlight cascades; those virtual tables have no foreign keys.
   Allow schema cascades to delete all users' book-linked progress, highlights, notes,
   reading sessions, associations, and file rows. Leave physical blobs for the later
   orphan sweep rather than deleting potentially shared covers.
6. Compute `sort_title` whenever the title is written: lowercase, move a leading English
   `the `, `a `, or `an ` to the end, and transliterate Han to toneless pinyin. For
   example, `The Great Gatsby` sorts as `great gatsby, the`; test Chinese and mixed
   Chinese/Latin titles as well as deterministic ordering and article handling. Expose a
   reusable helper for I1 and later metadata updates.
7. Implement `search.IndexBook` for use inside a caller's write transaction. Replace the
   `books_fts` row using the current title, ordered authors, series, tags, publisher,
   identifiers, and description, following database.md §8. Reindex atomically after
   changes to indexed fields or associations; delete the FTS row atomically on book
   deletion. Test the indexed content and rollback behavior against real SQLite. Search
   query endpoints and index rebuild jobs remain S1 and J1 work.
8. Implement safe content-addressed reads using system.md §4:
   `files/<sha256[:2]>/<sha256>.<format>`,
   `covers/<sha256[:2]>/<sha256>.jpg`, and
   `covers/<sha256[:2]>/<sha256>-w400.jpg`. Validate hashes and format allowlists before
   constructing paths; do not use a client-supplied name as a disk path.
   `GET /books/{id}/files/{fileId}` must verify that the file belongs to the visible book
   before opening it. Use `http.ServeContent` with the actual format's safe content type,
   a quoted SHA-256 ETag, `nosniff`, and a safely encoded download filename. Never serve
   a book as `text/html`. Support HEAD, byte ranges, and conditional requests. Missing or
   inaccessible files must not reveal paths or internals.

   File IDs can be reused after deletion, so the bare ID URL must use private revalidating
   caching rather than claiming its contents are immutable. Include a `?v=<sha256>` URL in
   the DTO and use private immutable caching only when `v` matches the current file hash;
   reject a mismatched version. Set `Vary: Cookie` so a browser does not reuse one session's
   cached response for another. Authorize before returning content or 304.
9. Implement `GET /books/{id}/cover` for the normalized JPEG and `?w=400` for its
   thumbnail. Reject unsupported width values. Use an ETag for the actual returned
   variant and private revalidating caching, since a book's cover can change at the same
   URL; set `Vary: Cookie` and authorize before returning content or 304. Missing covers
   return 404.

   Implement admin-only `PUT /books/{id}/cover` with a raw JPEG/PNG/GIF/WebP request body
   and optional `?source=upload|pdfjs` (default `upload`). Bound the body to
   `covers.MaxInputBytes`, use `covers.Normalize` outside the write transaction, and
   reject invalid or oversized images explicitly. Store the full JPEG and thumbnail at
   the layout above, keyed by the **full** JPEG's hash. Stage and publish both safely
   before committing the book's `cover_sha256`, `cover_source`, `updated_at`, and manual
   cover provenance; handle concurrent uploads and verify rather than overwrite existing
   shared blobs. Return 200 with `{ "cover_sha256": "...", "cover_source": "..." }`.
   Use a narrowly scoped cover-write helper; do not implement I1's general book-blob
   write pipeline. Do not delete preexisting shared blobs on failure; surface filesystem
   and database failures and leave unreferenced blobs for the later orphan sweep.
10. Use `application/problem+json` for errors: 401 without a session, 403 for non-admin
    writes, 404 for missing or invisible resources, 400 for malformed input, 409 for
    conflicts, and 413 for an oversized cover. Log unexpected failures with request
    context without exposing SQL, filesystem paths, or secrets to clients. Do not return
    success-shaped results for failed writes.
11. Add a table-driven visibility harness using a migrated temporary SQLite database.
    Seed multiple libraries, an admin, multiple regular users, grants, visible books,
    hidden books, inaccessible books, shared authors/tags/series, files, and covers.
    Include an admin's own hide entry: admins bypass grants, not their own hide list.
    Enumerate and exercise every C1 book-derived read query and relevant HTTP route for
    each viewer, including filters, counts, details, file/cover access, and missing IDs.
    Make the harness easy for later tasks to extend with every new catalog read; do not
    claim coverage for queries that have not yet been implemented.
12. Add focused tests for library CRUD and nonempty/default deletion, grants/revokes,
    hide/unhide including an admin's own entry, auth and cross-origin enforcement, book
    edit/delete and rollback, provenance, pinyin, deduplication, FTS consistency including
    annotation index cleanup on delete, pagination with ties and invalid cursors, and
    safe blob paths. HTTP tests must cover JSON mutation responses, MIME types, HEAD, Range,
    ETag/304, versioned and unversioned cache policies, `Vary: Cookie`, cover
    replacement/thumbnail, upload limits, wrong book/file pairs, and visibility after grant
    or hide changes. Use `httptest` and temporary data directories; do not bind fixed ports.

## Out of scope

- Creating/importing books, adding file formats, book-file uploads, drop watching, and the
  general blob write side (I1); seed books and files in tests for this task.
- Search query APIs and FTS rebuild jobs (S1 and J1).
- Shelves, reading/sync, metadata-provider integrations, OPDS, and KOReader (later tasks).
- Library, admin, and metadata UI, including browser PDF cover rendering (W1/W5/W6).
- New migrations, user-management APIs, and unrelated server settings.

## Acceptance criteria

- [x] Seeded catalog data is returned correctly to admin and regular viewers; all C1
  book-derived reads and HTTP routes obey the exact visibility predicate.
- [x] Admin library, grant, hide, book-update/delete, and cover-upload operations work;
  non-admin writes and cross-origin unsafe requests are rejected.
- [x] Metadata, field provenance, sort titles, FTS rows, and cascades stay consistent
  across successful writes and transaction failures.
- [x] File and cover endpoints authorize before serving, use safe paths and appropriate
  caching, and pass range, conditional, and image-limit tests.
- [x] Pagination is stable on ties and rejects invalid or mismatched cursors.
- [x] `task sqlc:check`, `task build`, `task lint`, and `task test` pass from the
  repository root; no migration or later-task implementation was added.

## Validation commands

```powershell
task sqlc
task sqlc:check
task build
task lint
task test
```

Build the embedded web assets first with `task web:build` if they are absent.

## Hand-off

- Set this prompt's status to `Done`, and update only the C1 row and append a C1 entry in
  [progress/README.md](../progress/README.md).
- Record the final DTOs, pagination/visibility conventions, and reusable catalog/index
  APIs for R1, W1, I1, and S1. Update architecture docs or add an ADR if implementation
  requires a genuine design change.

### Delivered

- The [catalog contract](../architecture/system.md#catalog-contract-c1) records DTOs,
  cursor ordering, visibility, cache validation, and downstream service/index APIs.
- Book metadata, manual provenance, FTS updates, and annotation-index cleanup share
  writer transactions. Cover variants are published before the database update, and
  shared or orphaned blobs are left for future maintenance.
- The migrated-SQLite visibility harness enumerates C1's book-derived reads. Tests cover
  tied/null pagination, auth and origin protection, rollback, Windows junction confinement,
  concurrent cover writes, and HTTP media and upload behavior.
- `task sqlc:check`, `task build`, `task lint`, and `task test` pass on Windows. The Go
  tests were run with a two-minute per-package timeout. F2 and X1 remain in Review.
