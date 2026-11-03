# O1: OPDS 1.2

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § O1
- Depends on (merged): S1, SH1
- Can run in parallel with: ST1, E1, W4
- Branch / worktree: `task/o1` in `..\pandalibrary-o1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 5–6, 9, 15
- [architecture/database.md](../architecture/database.md) §§1–5, 8–10
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md), and
  [ADR-0005](../decisions/0005-offline-sync-lww.md)
- [S1 search contract](./S1-search.md), [SH1 shelf contract](./SH1-shelves.md),
  `internal/auth/`, `internal/catalog/`, `internal/search/`, `internal/httpapi/`, and
  existing app-password and file-download handlers

## Goal

Implement an OPDS 1.2 Atom catalog at `/opds` for supported ebook clients. Authenticate
with the existing OPDS-kind app password, reuse catalog/search/shelf behavior, and ensure
every navigation and acquisition result respects current library access and hide rules.

## Scope

**Owns (create/modify freely):**
- `internal/opds/**`
- OPDS-specific HTTP handlers and tests under `internal/httpapi/` only if required by the
  existing mount architecture
- OPDS-specific tests in the owned packages

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — construct the OPDS service and append its mount
- `go.mod` / `go.sum` — only if a directly required dependency is missing
- [progress/README.md](../progress/README.md) — edit only the O1 row and append an O1 log

**Must not touch:**
- Database migrations, auth/app-password semantics, catalog/search/shelf behavior, or
  file storage
- Existing API routes or Basic-auth middleware behavior outside the new OPDS mount
- Web UI or other Step 9 task implementations

## Requirements

1. Implement OPDS 1.2 Atom navigation and acquisition feeds rooted at `/opds`. Require
   HTTP Basic authentication using the existing username plus an `opds` app password;
   reject missing, malformed, invalid, disabled-user, or wrong-kind credentials using
   existing authentication conventions. Do not accept the web-login password or a
   KOReader-kind app password. Keep password verification constant-time where applicable
   and never log credentials.
2. The root navigation feed links to Recently added, Libraries, Authors, Series, Tags,
   Shelves (the viewer's own private plus shared shelves; admins may also see private
   shelves), Reading now, and Want to read. Provide paged acquisition feeds with 50
   entries per page and valid Atom `rel="next"` links. Use stable ordering and opaque
   cursors where the existing services provide them; generated links must preserve the
   query/identity context required for the next page.
3. Add an OpenSearch description at `/opds/opensearch.xml` and a search feed that calls the
   existing S1 search service. Preserve its normalization, short-query fallback, page
   limits, rank order, and visibility behavior; do not duplicate or weaken search rules.
4. Each acquisition entry includes correct Atom/OPDS metadata, available format links,
   and cover/thumbnail links using `http://opds-spec.org/image` and
   `http://opds-spec.org/image/thumbnail` rel values. Acquisition URLs use
   `/opds/books/{id}/files/{fileId}` and the existing authorized file-serving path; do not
   expose filesystem paths or content-addressed storage internals. Include sensible MIME
   types and file sizes from catalog DTOs.
5. Use the exact catalog visibility predicate for every book in every feed, including
   Recently added, search, shelves, Reading now, and Want to read. Admins still do not
   bypass their own hide list. Do not expose inaccessible book IDs through links, counts,
   errors, or pagination.
6. Build absolute links only from the configured trusted public base URL or the router's
   validated request-origin handling. Do not trust an arbitrary `Host` or forwarded header
   when generating externally visible links. Ensure XML content types and XML-escape all
   metadata and URLs.
7. Validate serialized feeds against the OPDS 1.2 schema. Add tests for authentication
   kinds, navigation links, pagination, search, acquisitions, media types, XML escaping,
   visibility/hide-list filtering, and errors. Test the feeds with at least one real
   OPDS client (KOReader or another reader) and record the client/version and result in
   the progress log. Do not implement OPDS-PSE page streaming.

## Out of scope

- OPDS-PSE page streaming, write operations, or catalog management
- KOReader progress sync (K1)
- Search/shelf UI (W4)
- New authentication types, database tables, or schema migrations

## Acceptance criteria

- [ ] Root and navigation feeds expose the planned catalog sections.
- [ ] Search uses S1 and all feeds apply current visibility, including hide-list rules.
- [ ] All pages and acquisition links are valid Atom/OPDS 1.2 and point to authorized
  existing downloads.
- [ ] Schema validation and automated authentication/visibility/feed tests pass.
- [ ] A real client has been tested and the result recorded.
- [ ] `task build`, `task lint`, and `task test` pass.

## Validation commands

```powershell
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and O1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record the route/feed and client-compatibility details, including any client-specific
  limitation. Update architecture docs or add an ADR only if the accepted design changes.

## Implementation hand-off

- Use HTTP Basic with an OPDS app password only. The root path is `/opds`; OpenSearch is
  `/opds/opensearch.xml`; acquisition links use
  `/opds/books/{bookID}/files/{fileID}`.
- Each feed page contains at most 50 entries. The service's visibility predicate applies
  again for every page and every acquisition; clients must treat denied downloads as
  authorization changes, not as evidence that the book never existed.
- Implemented in [internal/opds](../../internal/opds), mounted from `internal/app`.
  Navigation: `/opds` (root), `/opds/libraries`, `/opds/authors`, `/opds/series`,
  `/opds/tags`, `/opds/shelves`. Acquisition: `/opds/recent`, `/opds/search?q=`,
  `/opds/libraries/{id}`, `/opds/authors/{id}`, `/opds/series/{id}` (series order),
  `/opds/tags/{id}`, `/opds/shelves/{id}` (manual order), `/opds/reading`,
  `/opds/want-to-read`. Covers: `/opds/books/{id}/cover` and `/thumbnail`. Pagination
  passes the catalog/search/shelf cursors through opaquely (status lists use their own
  viewer- and list-bound keyset cursor); a `next` link appears only when more exists.
- Auth: missing credentials get a `Basic realm="PandaLibrary OPDS"` challenge and do not
  count toward rate limiting; any presented credential is limited to 5 failures per
  client IP per 10 minutes (429). Web passwords and KOReader secrets/keys are rejected.
- Links are absolute only from the configured base URL (with its path prefix) and
  otherwise root-relative; request `Host` and forwarded headers are never used.
  Responses are `Cache-Control: private, no-store` with `Vary: Authorization`.
- Entries carry atom author/contributor (by role), `dc:` language/publisher/issued/
  identifier (`urn:isbn:` etc.), tag categories, a plain-text summary (series line plus
  escaped description), image/thumbnail links, and one acquisition link per file with
  its MIME type and `length`. Books with no files are omitted from acquisition feeds
  because an OPDS acquisition entry requires an acquisition link; pages may therefore
  hold fewer than 50 entries while still offering `next`.
- Validation: no RELAX NG tool (Java/Python/xmllint) is available, so
  `schema_test.go` ports the official OPDS 1.2 `opds.rnc`/Atom rules into a Go validator
  and checks every served feed and the OpenSearch description. The upstream `atomUri`
  pattern's `\nrt` typo is interpreted as the intended `\n\r\t`. The templated
  `rel=search` Atom link is not emitted because the schema forbids `{}` in hrefs; clients
  use the OpenSearch description instead.
- Client compatibility: feeds were parsed with Thorium Reader's OPDS library
  `r2-opds-js` 1.0.47 (OPDS 1 → OPDS 2 conversion): navigation, publications, `next`
  links, and acquisition links resolved correctly. KOReader could not be run in this
  environment; a manual KOReader check remains a follow-up.
