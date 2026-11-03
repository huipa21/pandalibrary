# M1: Metadata providers

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § M1
- Depends on (merged): C1, X1
- Can run in parallel with: W3, K1, J1
- Branch / worktree: `task/m1` in `..\pandalibrary-m1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 5–7, 11, 15–16
- [architecture/database.md](../architecture/database.md) §§1–5 and the metadata schema
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md), and
  [ADR-0003](../decisions/0003-auto-applied-migrations.md)
- The merged C1 catalog read/write and visibility APIs, X1 `extract.Metadata` provenance,
  database metadata tables, `internal/app/app.go`, `internal/httpapi/` admin/error
  conventions, and provider/cache contracts in the accepted architecture

## Goal

Provide bounded, cached metadata lookup from Open Library, Google Books, NeoDB, and
Hardcover, plus administrator-only provider configuration and per-field metadata apply.
Keep provider responses normalized and testable without live network access, and use the
existing catalog and provenance schema without a migration.

## Scope

**Owns (create/modify freely):**
- `internal/metadata/**`
- `internal/db/queries/metadata.sql` and generated sqlc output from `task sqlc`
- Metadata candidate, apply, and provider-admin handlers and tests under
  `internal/httpapi/`
- Focused provider fixtures under `internal/metadata/`

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — construct the service and add mount wiring without refactoring
  other services
- `internal/httpapi/routes.go` — add one mount registration line only
- `go.mod` / `go.sum` — add dependencies only when required
- [progress/README.md](../progress/README.md) — edit only the M1 row and append an M1 log

**Must not touch:**
- Migrations or existing catalog/extractor behavior
- W6 metadata merge UI or other Step 8 task code
- Provider secrets in logs, responses, fixtures, or committed configuration

## Requirements

1. Define the `Provider` interface and normalized `Candidate`/`Query` types in
   `internal/metadata/`, preserving the accepted fields: title, subtitle, people and roles,
   description, publisher, date, language, page count, series/index, tags, identifiers,
   cover URL, provider name, and provider record reference.
2. Implement Open Library, Google Books, NeoDB, and Hardcover adapters. Before coding,
   verify and record the current official endpoint, request, authentication, and response
   contracts for each provider. Send Open Library's descriptive User-Agent; support the
   optional Google Books key; support the configured NeoDB base URL and required NeoDB /
   Hardcover credentials. Bound response bodies and honor context cancellation.
3. Search by ISBN first; otherwise use title, first author, and language when available.
   Query enabled providers concurrently with an 8-second overall timeout and an
   independent token-bucket rate limit per provider. Return partial provider results with
   explicit provider errors rather than turning a failed provider into an empty success.
4. Cache normalized provider results in the existing `metadata_cache` table, including its
   schema version, request key, status, and expiry. Use the architecture TTLs: hit 30 days,
   not found 7 days, transient error 10 minutes. Handle stale schema versions and cache
   read/write failures explicitly. Use existing data/query patterns; do not add a migration.
5. Add administrator-only provider configuration APIs over the seeded
   `metadata_providers` rows. Support enabled state, priority, optional base URL and
   write-only API-token updates. Never return tokens or hashes, and never log secrets.
   Validate provider-specific configuration and reject unsafe URLs; do not allow
   book/user data to choose an API target.
6. Add administrator-only candidate lookup and per-field apply APIs for a catalog book.
   Use C1's catalog service for book visibility and updates; do not write catalog tables
   directly from handlers. Applying a field must be an explicit caller choice, validate
   that a selected provider/reference/value belongs to a returned candidate, update only
   the chosen fields, and record `book_field_sources` with source/reference/user/time.
   Preserve unchanged fields and existing provenance for fields not selected. Define and
   document stable DTOs/routes that W6 can consume.
7. Provider cover retrieval must accept only a URL associated with a cached candidate and
   an allowlisted provider host. Restrict schemes, revalidate redirects and resolved
   addresses, and reject loopback/private/link-local destinations unless the destination
   is the explicitly configured NeoDB instance. Set response time/size limits and validate
   image data before normalization through `covers.Normalize`. Never fetch an arbitrary
   user-supplied URL.
8. Test adapters with recorded HTTP fixtures and a test server; CI must make no live
   provider calls. Cover malformed/oversized responses, missing credentials, timeouts,
   rate limits, cache TTL/schema behavior, parallel partial failures, token redaction,
   unsafe URLs/redirects, visibility, per-field apply/provenance, and cover limits.

## Out of scope

- Metadata merge UI (W6), bulk PDF cover generation, or automatic metadata overwrite
- Provider-specific live calls in CI
- New schema migrations or changes to X1 extraction

## Acceptance criteria

- [x] All four providers normalize to the common `Candidate` type and use verified current
  official endpoint contracts.
- [x] Lookup uses configured parallel providers, bounded time/rate, and required cache TTLs.
- [x] Admin configuration never discloses tokens; candidate apply changes only explicitly
  selected fields and writes provenance.
- [x] Provider cover fetching is constrained to validated, allowlisted destinations and
  normalized safely.
- [x] Recorded fixtures cover success, failure, cache, apply, secrets, and URL safety; CI
  performs no live calls.
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

- Update this prompt's status and the M1 row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record verified provider endpoints/authentication, API DTOs for W6, cache behavior, and
  any provider limitations. Update architecture docs or add an ADR only if the accepted
  design changes.

### Provider contracts verified 2026-11-03

- **Open Library:** `GET https://openlibrary.org/search.json` accepts `isbn`, `title`,
  `author`, `lang`, `fields`, and `limit`; its `docs` contain work keys, titles, authors,
  dates, ISBNs, subjects, and `cover_i`. Covers use
  `https://covers.openlibrary.org/b/id/{cover_i}-L.jpg`. Send a descriptive User-Agent.
  See the official [search](https://openlibrary.org/dev/docs/api/search) and
  [covers](https://openlibrary.org/dev/docs/api/covers) documentation.
- **Google Books:** `GET https://www.googleapis.com/books/v1/volumes` uses `q` with
  `isbn:`, `intitle:`, and `inauthor:` terms, `langRestrict`, `maxResults`, and an
  optional `key`. Results are `items[].id` and `items[].volumeInfo`. Google's
  [list reference](https://developers.google.com/books/docs/v1/reference/volumes/list),
  [volume reference](https://developers.google.com/books/docs/v1/reference/volumes), and
  [authorization guide](https://developers.google.com/books/docs/v1/using#auth) note that
  public requests should identify the application with an API key or OAuth token; an
  unconfigured key remains optional in PandaLibrary, so Google may reject such requests.
- **NeoDB:** the official
  [catalog API source](https://github.com/neodb-social/neodb/blob/main/neodb/catalog/apis.py)
  defines `GET {base}/api/catalog/search?query=...&category=book` and
  `GET {base}/api/book/{uuid}`; search returns `data`, `pages`, and `count`.
  [EditionSchema](https://github.com/neodb-social/neodb/blob/main/neodb/catalog/models/book.py)
  supplies `author`, `translator`, `publisher`, `language`, `pub_year`, `pub_month`,
  `pages`, `series`, and `isbn`; the
  [base schema](https://github.com/neodb-social/neodb/blob/main/neodb/catalog/models/item.py)
  supplies `uuid`, `title`, `description`, `cover_image_url`, `credits`, and `tags`.
  These upstream reads are public, but PandaLibrary requires the configured NeoDB token
  and sends it as a bearer token, in accordance with the accepted design.
- **Hardcover:** `POST https://api.hardcover.app/v1/graphql` requires an authorization
  bearer token with catalog-search access. The
  [search guide](https://docs.hardcover.app/api/guides/searching/) specifies
  `search(query:, query_type: "Book", per_page:, page:) { results }`; the JSON result
  contains Typesense book documents, including title, author names, ISBNs, series, tags,
  pages, date, and description where available. See also the
  [getting-started guide](https://docs.hardcover.app/api/getting-started/) and
  [book schema](https://docs.hardcover.app/api/graphql/schemas/books/). The API is beta
  and its search index is subject to upstream changes.

### Implemented API contract for W5/W6

All routes require an administrator cookie session. Mutating requests use the existing
cookie-origin protection. JSON responses and cover previews use `Cache-Control: no-store`;
errors use the existing problem response format.

| Method | Route | Request / response |
|---|---|---|
| GET | `/api/v1/admin/metadata/providers` | `{providers: ProviderSettings[]}` ordered by priority then provider |
| PATCH | `/api/v1/admin/metadata/providers/{provider}` | Partial `{enabled, priority, base_url, api_token}`; returns `{provider: ProviderSettings}` |
| POST | `/api/v1/books/{id}/metadata/candidates` | No body or query parameters; returns `{request_key, query, providers: ProviderResult[]}` |
| POST | `/api/v1/books/{id}/metadata/apply` | `{request_key, fields: {field: {provider, reference}}}`; returns `{book}` using the existing C1 DTO |
| POST | `/api/v1/books/{id}/metadata/cover` | `{request_key, provider, reference}`; returns normalized `image/jpeg` for preview |

- `ProviderSettings` has `provider`, `enabled`, `priority`, nullable `base_url`,
  `has_token`, and UTC `updated_at`. Tokens and token hashes are never returned.
  An absent token preserves it; `api_token: null` removes it. Disable NeoDB/Hardcover
  in the same patch when removing their required credential. Google Books accepts an
  optional key; Open Library does not accept a token. Priority is an integer 0–10000.
- Only NeoDB accepts a non-null `base_url`, an HTTP(S) origin with no credentials,
  path, query, or fragment. Null restores `https://neodb.social`. Other API destinations
  are fixed. Tokens/base URLs never come from book data or candidate requests.
- `ProviderResult` has `provider`, `candidates` (always an array), and nullable
  `error: {code, message}`. A failed provider does not discard other results. Errors
  are sanitized; raw HTTP response errors and credential-bearing URLs are not exposed
  or logged. A cache-write failure is explicit even if candidates were retrieved.
- Candidate fields are `provider`, `reference`, `title`, nullable `subtitle`,
  `description`, `publisher`, `published_date`, `language`, `page_count`, `series`,
  and `cover_url`; `authors: [{name, role}]`, `tags: string[]`, and
  `identifiers: [{scheme, value}]` are arrays. Series is `{name, index}` with nullable
  decimal index. Dates are normalized to YYYY, YYYY-MM, or YYYY-MM-DD.
- Apply supports `title`, `subtitle`, `authors`, `description`, `language`, `publisher`,
  `published_date`, `page_count`, `series`, `tags`, `identifiers`, and `cover`. Each
  field can select a different candidate. There is deliberately **no caller-supplied
  value or cover URL**: the server derives the value from the selected cached record.
  Choosing a null nullable field or an empty array explicitly clears that field;
  leaving a field out preserves both its value and provenance.
- Keep the returned opaque `request_key` with the selections. It binds the lookup to
  the catalog book, not to an arbitrary query. Expired, stale-schema, disabled, or
  invalidated selections return 409; repeat lookup. Hidden and nonexistent books both
  return 404, including for administrators with a hide entry.
- `catalog.ApplyMetadata` is the small C1 integration added for M1: it shares existing
  catalog patch validation and commits selected values, cover reference, provenance,
  and FTS together. Existing manual edit behavior is preserved. Cover bytes are
  normalized and published outside the write transaction, as with existing covers.

### Cache, network bounds, and provider limitations

- Cache schema is **1**. Keys are `book:<id>:<sha256(normalized query)>`; the hash
  contains no credentials. ISBN-13 takes precedence over ISBN-10; otherwise query uses
  title, first author-role contributor, and language. This scopes apply selections
  to the book while allowing an explicit selection to survive unrelated book edits.
- Status 200 retains hits for 30 days, 404 retains misses for 7 days, and 503 retains
  sanitized transient failures for 10 minutes. Expired/stale-schema rows are misses;
  malformed cache rows and database read/write failures are explicit errors. Every
  provider configuration update clears its cache atomically. Configuration changes
  synchronize with lookup/apply so in-flight responses cannot resurrect cleared rows.
- Enabled providers run concurrently within an 8-second overall context; provider work
  has a 7-second ceiling to reserve time for caching a timeout. Waiting for configuration
  or a rate token also honors cancellation. Each provider has an independent 1 request/s,
  burst-1 token bucket. Responses are limited to 2 MiB and 10 normalized candidates.
- Open Library sends `PandaLibrary/1.0 (self-hosted ebook catalog; metadata lookup)`.
  Search records do not supply every edition field; unavailable values remain null.
  Google keys remain optional but quotas/authentication can reject keyless requests.
  NeoDB's `pages` supports its documented numeric and legacy string forms.
  Hardcover requires a token with `read:catalog` (or the necessary catalog-search
  scope); its search result can be a JSON object or a JSON-encoded string.
  Its record lookup uses `books` and `contributions` with the official
  [contributor relationship](https://docs.hardcover.app/api/graphql/schemas/contributions/).
  Supported contributor roles are author, translator, editor, and illustrator.
- Covers accept only the selected cached URL. HTTPS host allowlists are
  `covers.openlibrary.org`; `books.google.com` / `books.googleusercontent.com`;
  `neodb.social` / `neodb-cdn.b0.upaiyun.com`; and `assets.hardcover.app`, respectively.
  Unknown CDN hosts fail closed. HTTP/private destinations are allowed **only** for
  the exact explicitly configured NeoDB origin (including scheme and port), not for
  arbitrary redirects. Administrators must trust the instance they configure.
- Every cover redirect is checked again (at most two redirects); every DNS answer must
  be public unless the exact NeoDB exception applies. Connections dial validated IPs
  directly to prevent DNS rebinding. Environment proxies are not used; API redirects
  cannot cross origins. Cover requests never forward provider tokens or user cookies.
- Cover downloads have an 8-second context, 20 MiB encoded limit, and 20-million-pixel
  limit. `covers.Normalize` validates actual image data and produces at-most-1200px
  JPEGs and 400px thumbnails without upscaling.
- Offline tests use minimized, credential-free HTTP contract fixtures based on the
  official schemas, local HTTP/TLS servers, and stub providers. No authenticated live
  provider validation was performed and CI makes no live provider calls. Tests exercise
  malformed/oversized responses, missing credentials, cancellation and the measured
  timeout, parallel partial failures, rate limits, cache TTL/schema/failures,
  token redaction, visibility, all apply fields, transactional rollback, cover limits,
  redirects, DNS/private-address rejection, and the explicit NeoDB exception.
- Validation: `task sqlc`, `task sqlc:check`, `task build`, `task lint`, and `task test`
  passed on 2026-11-03. No migrations, dependencies, or metadata UI were added.
