# S1: Search

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § S1
- Depends on (merged): C1
- Can run in parallel with: W2, I1, SH1
- Branch / worktree: `task/s1` in `..\pandalibrary-s1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 5–6, 15
- [architecture/database.md](../architecture/database.md) §§4–5, 7–8, 10
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md) and
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- C1's catalog DTOs, SQL visibility predicate, pagination conventions, and the existing
  `internal/search/index.go` / catalog write calls that keep `books_fts` current
- `internal/httpapi/catalog.go`, `internal/httpapi/reading.go`, current mount wiring, and
  the generated sqlc package

## Goal

Complete the query side of book search on the existing FTS5 index and expose a bounded,
authenticated API. Search must support CJK substring and short-query fallback, rank useful
matches deterministically, and never reveal books outside the caller's current catalog
visibility.

## Scope

**Owns (create/modify freely):**
- Search-query functionality under `internal/search/**`; preserve `IndexBook` behavior
- `internal/db/queries/search.sql` and generated sqlc output from `task sqlc`
- Search HTTP handler and tests under `internal/httpapi/`

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — construct and append the search mount using current application
  wiring
- `go.mod` / `go.sum` — only if a required text-normalization dependency is missing
- [progress/README.md](../progress/README.md) — edit only the S1 row and append an S1 log

**Must not touch:**
- `internal/db/migrations/**`, catalog visibility rules, catalog metadata writes, or
  `search.IndexBook` call sites
- `internal/reading/**` or `/api/v1/search/annotations` behavior
- Shelves implementation (SH1), search/shelves UI (W4), or OPDS (O1)

## Requirements

1. Implement authenticated `GET /api/v1/search?q=...&limit=...&cursor=...`. Require exactly
   one non-empty query, reject malformed or duplicate query parameters and invalid limits or
   cursors with 400, and return a bounded `{ "items": [...], "next_cursor": null }` page
   (default 50, maximum 100). Bind opaque cursors to normalized query and viewer; order by
   FTS rank then book ID so tied ranks cannot skip or repeat results.
2. Return a documented, stable search-result DTO sufficient to render a result row in W4
   (book ID, title, ordered author names, optional series, optional cover URL, and rank).
   Do not import `internal/catalog` from `internal/search`: catalog already imports search
   for transactional indexing. Keep the query-side DTO and SQL dependency direction
   acyclic.
3. Normalize with Unicode NFKC and trim; split into whitespace-delimited terms. Safely quote
   terms of at least three characters for trigram `MATCH` (double embedded quotes) and
   combine them with `AND`. Apply shorter terms as escaped `LIKE` constraints to the
   matched rows; when all terms are shorter than three characters, use only the LIKE path.
   Escape `\`, `%`, and `_`, bind every value, and never concatenate raw user input into SQL
   or FTS syntax.
4. Apply the exact C1/database.md §5 visibility predicate to every returned book, including
   both FTS and LIKE query paths. A hidden book must remain hidden even from an admin. Do
   not reveal inaccessible book IDs through counts, snippets, errors, or pagination.
5. Apply filters before pagination and ranking consistently. Use the existing FTS5
   persistent BM25 weights (`10, 6, 4, 3, 1, 8, 1`); do not change index weights or content
   maintenance. Confirm author/series/tag/publisher/identifier/description matches use the
   indexed columns already maintained by `search.IndexBook`.
6. Keep annotations search separate: R1 already owns
   `GET /api/v1/search/annotations`; mount the book-search route without replacing or
   changing that endpoint. Use existing session authentication, `httpapi.Mount`, and
   problem-response conventions.
7. Add tests through the service and HTTP API for:
   - Trigram CJK substring search (`黑暗森` matching `三体Ⅱ：黑暗森林`).
   - A 2-character Chinese query through LIKE (`三体`) and a short author-column query.
   - Accent-insensitive matching (`cafe` matching `Café`).
   - Literal quote, backslash, `%`, and `_` handling; multiple-term AND behavior.
   - BM25 ordering, deterministic tie-breaking, page/cursor binding, malformed queries,
     and invalid limits.
   - Library access and hide-list filtering for regular users and admins.
8. Use the writer/reader pools and sqlc conventions. Keep read consistency for each result
   page, avoid N+1 queries, and make database errors explicit through existing HTTP error
   logging. Do not add migrations or an external search service.

## Out of scope

- Index maintenance changes or catalog mutations (C1)
- Annotation/note search (R1)
- Search and shelves web UI (W4)
- OPDS query integration (O1)

## Acceptance criteria

- [x] All search cases in [database.md](../architecture/database.md) §10 pass through the
  service and API.
- [x] Search never returns a hidden or inaccessible book, including to admins.
- [x] Pagination is stable, bounded, and tied to the normalized query and viewer.
- [x] Existing `search.IndexBook` indexing and annotation search continue to work.
- [x] `task sqlc:check`, `task build`, `task lint`, and `task test` pass.

## Validation commands

```powershell
task sqlc:check
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and S1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Document the response DTO and pagination contract for W4 and O1.
- Update architecture docs or add an ADR only if the accepted design changes.

## Implementation hand-off

- `GET /api/v1/search?q=...&limit=...&cursor=...` returns
  `{"items":[{"id":101,"title":"...","authors":["..."],"series":null,
  "cover_url":null,"rank":-0.1}],"next_cursor":null}`. A non-null `series` is
  `{"id":1,"name":"...","index":1.5}`; `index` may be null. Authors are ordered by
  catalog position, author ID, then role. Covers use the existing authorized cover URL.
- Lower BM25 ranks are more relevant; ties use ascending book ID. Short-term-only LIKE
  searches have rank `0` and are ordered by ID. Every result applies the current viewer's
  library grants and hide list, including for admins.
- `limit` defaults to 50 and is capped at 100. Pass `next_cursor` back verbatim with the
  same NFKC-normalized query and viewer; changing either rejects the cursor. Cursors are
  not authorization tokens, and visibility is checked again for every page. Ranking may
  change between requests if the index changes, so consumers should restart pagination
  after a catalog change.
- Queries are UTF-8, at most 4,096 raw bytes and 1,024 bytes after NFKC normalization
  and whitespace collapsing, with at most 32 terms. Long terms use quoted trigram MATCH;
  short terms use escaped LIKE across all indexed metadata fields.
- Visibility tests reuse the catalog's viewer matrix in
  `internal/catalog/search_visibility_test.go`; the application mount is covered in
  `internal/app/search_mount_test.go`. These are test-only additions outside the search
  package.
