# W6: Metadata merge UI

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § Step 10
- Depends on (merged): M1, W1
- Can run in parallel with: W5, W7
- Branch / worktree: `task/w6` in `..\pandalibrary-w6`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§5, 11–12, 15
- [architecture/database.md](../architecture/database.md) §§1–5
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md),
  [M1 provider and metadata API hand-off](./M1-metadata-providers.md), and the merged
  catalog detail/editor, reader PDF.js asset setup, API, localization, and test patterns

## Goal

Allow administrators to compare current book metadata with cached provider candidates,
choose values independently per field, preview/select a provider cover, and safely
generate covers for visible PDF books that do not already have one.

## Scope

**Owns (create/modify freely):**
- `web/src/routes/books/[id]/edit/**`
- Metadata merge and PDF-cover batch helpers/components/tests under `web/src/lib/`
- Focused UI tests alongside owned source files

**Shared files (append-only, see plan §4):**
- `web/src/routes/books/[id]/+page.svelte` — add an edit link visible only to admins
- `web/messages/en.json` and `web/messages/zh.json` — add matching W6 keys only
- `web/package.json` / `web/pnpm-lock.yaml` — only if a required dependency is justified
- [progress/README.md](../progress/README.md) — edit only the W6 row and append a W6 log

**Must not touch:**
- `internal/**`, API contracts, migrations, generated `web/src/lib/paraglide/**`, or
  existing catalog metadata semantics
- Admin provider-configuration pages (W5), stats/notes/export UI (W7), reader behavior,
  and offline sync

## Requirements

1. Add `/books/{id}/edit` using the existing catalog detail DTO and typed API client.
   Expose entry to administrators only, but treat the server's `401`, `403`, and `404`
   responses as authoritative. Keep the existing book detail route and ordinary browsing
   behavior intact.
2. Fetch provider candidates with
   `POST /api/v1/books/{id}/metadata/candidates`. Retain the returned opaque
   `request_key`; render each provider's candidates and sanitized per-provider errors
   independently, so one failed provider does not erase successful results. On `409`
   expired/stale/invalid selections, repeat the lookup and require the user to select
   again. Do not invent candidate values, caller-supplied cover URLs, or provider fields.
3. Render a comparison grid for the current book value and provider results for supported
   fields: title, subtitle, authors, description, language, publisher, publication date,
   page count, series, tags, identifiers, and cover. Let the administrator choose a
   candidate per field independently, defaulting to keeping the current value. Preserve
   ordered authors, roles, tags, identifiers, and nullable series index when displaying
   candidate data. Do not treat an omitted selection as a clear.
4. Apply selected provider fields with
   `POST /api/v1/books/{id}/metadata/apply` using
   `{request_key, fields: {field: {provider, reference}}}`. The server derives values
   from its cached candidate; never send edited candidate values or cover URLs. An
   explicit null/empty candidate value clears the nullable field/array only when chosen;
   otherwise leave that field and its provenance unchanged. Replace the displayed book
   with the returned `{book}` DTO and show a success state.
5. If offering manual value edits, use the existing catalog `PATCH /api/v1/books/{id}`
   contract, validate the exact C1 DTO, and keep it separate from provider selections.
   Do not route manually entered values through the metadata apply endpoint. Preserve
   C1 validation errors and avoid partial UI success.
6. Allow preview of a selected provider cover through
   `POST /api/v1/books/{id}/metadata/cover` with `{request_key, provider, reference}`.
   Treat the response as normalized `image/jpeg`; create and revoke object URLs safely,
   do not fetch candidate URLs directly, and do not render untrusted remote images.
   Applying the `cover` field must use the same request key and cached-candidate selection.
7. Add a batch action to generate covers for books with a PDF and no current cover. Page
   through the existing library and book catalog APIs using their returned cursors; never
   synthesize offsets, bypass the current viewer's hide list, or load the whole library
   into memory. Filter only visible book DTOs with a PDF file and no `cover_url`.
   Recheck each book before upload so an existing cover is not overwritten.
8. For each eligible PDF, use the existing validated same-origin file URL and authenticated
   file-fetch pattern from `web/src/lib/reader/api.ts`. Render only its first page with
   the existing pinned `pdfjs-dist` worker/asset configuration, at a bounded scale and
   image size; release PDF documents, canvases, object URLs, and blobs promptly. Upload
   the generated JPEG/PNG bytes with `PUT /api/v1/books/{id}/cover?source=pdfjs` as a
   raw image body (not JSON or multipart). Process sequentially or with a very small
   explicit concurrency bound, expose progress, allow cancellation between books, and
   report per-book success/failure without silently skipping failures. Never overwrite an
   existing cover or expose storage paths.
9. Add clear loading, empty, partial-provider-error, validation, conflict, and retry
   states. Disable duplicate lookups/applies/uploads while pending; discard stale results
   after book navigation. Add English and Chinese text for all new UI and ensure accessible
   controls, keyboard operation, responsive layout, and status announcements.
10. Add focused Vitest tests for candidate mapping/selection, request-key reuse and 409
    recovery, cover URL lifecycle, PDF candidate filtering/render bounds, cancellation,
    and upload failures. Add Playwright coverage for candidate selection/apply and a
    representative PDF-cover batch path. Do not change backend contracts to simplify UI.

## Out of scope

- Provider configuration, credentials, and maintenance (W5)
- Stats, notes, and export (W7)
- Backend metadata/provider behavior, cover normalization, schema, or catalog authorization
- Replacing or bypassing the existing PDF reader worker/security constraints

## Acceptance criteria

- [ ] `/books/{id}/edit` displays current/candidate values and applies per-field selections
  with the current M1 request-key contract.
- [ ] Provider failures and stale requests are recoverable without exposing raw upstream
  errors or remote cover URLs.
- [ ] The PDF batch finds only visible PDFs missing covers, renders bounded previews, and
  never overwrites an existing cover.
- [ ] All new user-facing copy exists in English and Chinese and is keyboard accessible.
- [ ] `pnpm --dir web check`, `pnpm --dir web test`, `pnpm --dir web build`, and focused
  Playwright tests pass.

## Validation commands

```powershell
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:e2e -- --workers=2
```

## Hand-off

- Update this prompt's status and W6's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record PDF render limits, batch cancellation behavior, and any provider/API limitation.
  Update architecture docs or add an ADR only if the accepted design changes.
