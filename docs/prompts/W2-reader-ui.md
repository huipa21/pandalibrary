# W2: Reader UI

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § W2
- Depends on (merged): R1, W1
- Can run in parallel with: I1, S1, SH1
- Branch / worktree: `task/w2` in `..\pandalibrary-w2`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§5–6, 10, 12, 15
- [architecture/database.md](../architecture/database.md) §§3, 5–7
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md), and
  [ADR-0006](../decisions/0006-koreader-sync-compat.md)
- The merged R1 reading/sync API and DTOs in `internal/reading/` and
  `internal/httpapi/reading.go`
- W1's book detail/API helpers, `web/src/lib/api/client.ts`, app shell, Paraglide messages,
  test setup, and the six-format `files` DTO returned by C1

## Goal

Build a secure, accessible browser reader for all supported book formats on top of the
merged catalog and reading APIs. Restore and persist the user's position, annotations,
notes, reader preferences, and reading sessions without taking on the offline PWA work
reserved for W3.

## Scope

**Owns (create/modify freely):**
- `web/src/routes/read/**`
- `web/src/lib/reader/**` — common reader contract and format adapters
- Reader-only tests and fixtures alongside owned source files

**Shared files (append-only, see plan §4):**
- `web/messages/en.json` and `web/messages/zh.json` — add matching `reader.*` keys only
- `web/package.json` / `web/pnpm-lock.yaml` — add only justified reader dependencies;
  preserve both sides when resolving lockfile conflicts
- `web/src/lib/nav.ts` — only if the reader needs a top-level navigation entry
- [progress/README.md](../progress/README.md) — edit only the W2 row and append a W2 log

**Must not touch:**
- `web/src/service-worker.ts`, `web/src/lib/sync/**`, IndexedDB outbox, or offline book
  caching (W3)
- Backend APIs, database schema, auth/session behavior, catalog pages, or admin UI
- Generated `web/src/lib/paraglide/**`

## Requirements

1. Implement `/read/{bookId}/{fileId}` using W1's typed API client and C1 DTOs. Load the
   visible book and selected file from the existing catalog API, then fetch its returned
   hash-versioned `download_url` with the authenticated browser session. Handle missing
   books/files, unsupported formats, API errors, network failures, loading, and retry states
   with localized UI. Do not construct or expose filesystem paths.
2. Define a typed, format-neutral `Reader` contract for opening a `Blob`, navigating by a
   saved locator or fraction, reporting relocation as `{fraction, locator}`, applying
   settings, and rendering/removing annotations. Implement the reflowable formats (EPUB,
   MOBI, AZW3, FB2, FBZ, and CBZ) with foliate-js and PDF with pdf.js. Select the adapter
   from the returned file format; do not infer a format from the filename alone.
3. Keep untrusted book content isolated from the application origin. Do not relax the
   server's CSP or execute scripts, event handlers, or active content embedded in EPUB
   documents. Include a regression test with a script-bearing EPUB fixture that proves the
   payload cannot execute in the reader or affect the host application.
4. On open, read `GET /api/v1/me/books/{id}` and the relevant `/api/v1/me/settings` values.
   Restore the latest compatible progress locator, fall back to percentage when the saved
   file/locator cannot be used, and persist the current file ID, source, locator, percentage,
   and device metadata through the exact R1 `/api/v1/sync/push` mutation contract. Debounce
   progress writes and flush on a deliberate close/visibility transition without blocking
   navigation indefinitely. Use R1's validation limits and ownership semantics; do not
   invent a parallel write API.
5. Add, render, edit, and delete highlights and notes through R1's sync mutations. Render
   annotations in reading order and restore them after reload. Notes are Markdown: provide a
   CodeMirror 6 editor and a preview sanitized with DOMPurify before insertion. Never inject
   raw note or book HTML into the host DOM.
6. Persist reader settings using the existing `user_settings` sync entity and key convention
   (`reader.<format>` and optional `reader.book.<id>`). Provide accessible controls for the
   applicable font, size, spacing, theme, and flow options; validate settings before applying
   them and preserve unknown settings safely.
7. Record reading sessions using the R1 session mutation shape. Follow the architecture's
   lifecycle: start when the reader becomes active, account only for active time, close on
   hide/close, and avoid submitting sessions shorter than 30 seconds. Do not fabricate
   success when a session write fails; report/retry it through the current online UI.
8. Use semantic headings, keyboard-operable controls, visible focus, responsive layouts,
   meaningful accessible labels, and complete natural English and Chinese translations.
   Preserve the app shell, locale switching, and routing behavior. Do not add a service
   worker or an offline queue.
9. Add focused unit/component tests for adapter selection, progress restore and fallback,
   settings, annotation lifecycle, API errors, and session timing. Add a browser test for
   the end-to-end reader flow and the embedded-script regression, using the existing
   Playwright setup; do not add test tooling without need.

## Out of scope

- Offline caching, IndexedDB outbox, background sync, and offline storage settings (W3)
- Search and shelf interfaces (W4)
- Reader APIs or schema changes (R1 is merged)
- Catalog browsing, metadata editing, or import administration

## Acceptance criteria

- [x] EPUB, MOBI, AZW3, FB2, FBZ, CBZ, and PDF open through the correct adapter.
- [x] Progress round-trips through R1, and highlights render after a reload.
- [x] Notes and settings use the existing sync APIs and are safe to render.
- [x] The CSP/script-bearing EPUB test proves embedded code cannot execute in the app.
- [x] All new user-facing text is translated in English and Chinese.
- [x] `pnpm --dir web check`, `pnpm --dir web test`, and `pnpm --dir web build` pass;
  reader Playwright tests pass.
- [x] No offline/PWA implementation is introduced.

## Validation commands

```powershell
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:e2e
```

## Hand-off

- Update this prompt's status and W2's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record any reader-library/CSP constraints that W3 must preserve.
- Update architecture docs or add an ADR only if the accepted design changes.

### Implementation hand-off (2026-11-03)

- Added the Read navigation entry and a reader-owned book/format chooser without changing
  catalog pages. Foliate handles the six non-PDF formats; PDF.js provides a canvas, selectable
  text layer, normalized highlight rectangles, and bundled same-origin worker/decoding assets.
  CBZ uses page highlights, and KF8 non-linear placeholder sections retain their original indices.
- Progress, annotations, Markdown notes, per-book settings, and active reading sessions use
  the existing R1 DTOs and push mutations. Restore prefers compatible web locators and falls
  back to fractions. Unknown book settings survive edits. Failed progress/session writes
  remain retryable in memory while the reader is open, including across file changes;
  this is not a durable queue or an offline guarantee.
- **W3 security constraint:** pinned `foliate-js@1.0.1` creates frames with both
  `allow-same-origin` and `allow-scripts`; its sandbox alone is not the security boundary.
  Every rendered section must still pass through `safe-content.ts`, which removes active
  content, validates resource/link URLs, and prepends a restrictive section CSP with
  `script-src 'none'`. Preserve this even if files are later served from offline storage.
  Narrow internal `filepos:` and `kindle:pos:` navigation links remain supported.
- Do not relax the application CSP. Chromium blocks `fetch(blob:)` under the existing
  `connect-src 'self'`; section isolation instead temporarily captures Foliate-created HTML
  Blob references and reads their text directly. Overlapping captures restore the native
  object-URL API when the last operation completes. Original/sanitized URLs are released
  on unload/destroy. Keep PDF workers, CMaps, fonts, and WASM same-origin.
- Validation: `check` reports zero errors/warnings; all 30 frontend unit tests and all
  16 Playwright tests pass, and the production build passes. Browser tests use generated
  EPUB, MOBI6, genuine KF8/AZW3, FB2, FBZ, CBZ, and PDF fixtures. They cover mobile layout,
  position/highlight reload, Markdown safety, annotation edits/deletes, settings preservation,
  Chinese entry flow, failure retry, and session close. The EPUB regression exercises inline
  scripts, same-origin external scripts, and image/mouse event handlers under a representative
  production CSP/nonce, asserting no payload execution or external-script request.
  Playwright ran on isolated port 4193 because the normal 4173 port was already occupied.
- No service worker, IndexedDB, offline cache, backend/schema change, or architecture change
  was introduced.
