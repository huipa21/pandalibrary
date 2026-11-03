# K1: KOReader sync

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § K1
- Depends on (merged): R1, I1
- Can run in parallel with: W3, M1, J1
- Branch / worktree: `task/k1` in `..\pandalibrary-k1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 5–8, 15–16
- [architecture/database.md](../architecture/database.md) §§1, 5–6
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md), and
  [ADR-0006](../decisions/0006-koreader-sync-compat.md)
- The merged `internal/auth/` app-password service, `internal/reading/` sync service and
  mutation validation, `internal/catalog/` visibility and file lookup, `internal/importer/`
  file registration, `internal/covers/`-independent partial-MD5 helper, and
  `internal/httpapi/` mount/auth/error conventions

## Goal

Implement the KOReader-compatible `/kosync` protocol as an adapter over existing auth,
catalog, and reading state. Preserve raw KOReader records for exact device-to-device sync,
while mapping visible imported files into the existing user's reading progress and
sessions.

## Scope

**Owns (create/modify freely):**
- `internal/kosync/**` except shared application/router wiring
- Focused protocol, service, and integration tests alongside the package
- KOReader handler files and tests under `internal/httpapi/`

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — construct the adapter and add its route mount without changing
  existing service construction or lifecycle behavior
- `internal/httpapi/routes.go` — add one mount registration line only, following the
  existing `httpapi.Mount` pattern
- `go.mod` / `go.sum` — add dependencies only if required
- [progress/README.md](../progress/README.md) — edit only the K1 row and append a K1 log

**Must not touch:**
- Migrations or the existing partial-MD5 algorithm
- `internal/reading/` sync rules, catalog visibility rules, or app-password storage
- OPDS routes or other Step 8 task code

## Requirements

1. Mount the protocol under `/kosync` and implement:
   - `POST /kosync/users/create` as refused (accounts are created through PandaLibrary).
   - `GET /kosync/users/auth` using KOReader's `x-auth-user` and `x-auth-key` headers.
   - `PUT /kosync/syncs/progress` for `{document, progress, percentage, device, device_id}`.
   - `GET /kosync/syncs/progress/{document}` with the compatible progress record.
   - `GET /kosync/healthcheck` returning `{"state":"OK"}`.
   Verify protocol status codes, content types, and response bodies against the accepted
   architecture and golden fixtures; keep error responses compatible with KOReader.
2. Authenticate only with `auth.Service.VerifyAppPassword(..., "kosync", ...)`, passing
   KOReader's supplied MD5 hex value as expected by that service. Do not implement a
   separate password/hash path. Reject missing, malformed, disabled, or invalid users
   without revealing credential details. Keep `users/create` unavailable regardless of
   authentication state.
3. Validate request sizes and fields before persistence. `document` is KOReader's binary
   partial-MD5 digest (1–64 characters); preserve its raw `progress`, percentage, device,
   device ID, and timestamp semantics for exact KOReader-to-KOReader round trips. Unknown
   document digests must still sync as raw KOReader records.
4. On PUT, upsert `kosync_progress`. If `document` resolves to an imported `book_file`,
   only bridge it to `reading_progress` when the authenticated user can see the book.
   Use `source="koreader"` and the existing reading service's LWW validation/write
   contract; map page locators for PDF/CBZ and XPointer locators for reflowable formats.
   Do not expose hidden/inaccessible catalog records through protocol responses.
5. Record a server-derived `reading_sessions` entry with `source="koreader"`: extend the
   same-device session when the prior push was within 15 minutes; otherwise start a new
   session. Keep session timing and progress writes consistent with the system contract.
6. On GET, return the raw KOReader row unchanged when it is at least as new as
   `reading_progress`. If web progress is newer, synthesize a paged position from the exact
   PDF/CBZ page locator or a chapter-level
   `/body/DocFragment[<spine+1>]/body` XPointer with the web percentage for reflowable
   books. If a target device cannot accept the synthesized XPointer, preserve and return
   the last KOReader XPointer so KOReader can show its newer-progress prompt; do not
   fabricate an exact locator.
7. Add golden request/response tests for every endpoint, valid and invalid credentials,
   unknown and known document digests, raw KOReader round trips, web-vs-device freshness,
   visible/inaccessible books, malformed and oversized fields, and session extension/new
   session boundaries. Use a temporary migrated SQLite database; no live service calls.
8. Validate chapter-level XPointer behavior on a real KOReader device if one is available.
   Record the device/model, format, and result in progress. If no device test can be run,
   explicitly record that and implement/document the safe last-KOReader-XPointer fallback.

## Out of scope

- A KOReader plugin, file rewriting, or changing the importer digest algorithm
- OPDS, browser-reader changes, migrations, or new sync semantics
- Returning catalog information to KOReader beyond the accepted progress protocol

## Acceptance criteria

- [x] All five `/kosync` endpoints match the protocol using golden request/response tests.
- [x] KOReader app-password auth reuses `auth.Service`; unknown documents still round-trip.
- [x] Known visible documents bridge to R1 progress and sessions; inaccessible books do not
  leak catalog data.
- [x] Web-newer progress uses the prescribed page/XPointer mapping or the documented safe
  fallback.
- [x] A real-device result or the unavailable-device fallback is recorded in progress.
- [x] `task sqlc:check`, `task build`, `task lint`, and `task test` pass.

## Validation commands

```powershell
task sqlc:check
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and the K1 row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record the device-test result/fallback and any KOReader compatibility finding. Update
  architecture docs or add an ADR only if the accepted protocol design changes.

### Implementation (2026-11-03)

- All five endpoints are mounted in the application, using KOReader JSON responses
  rather than cookie authentication or problem responses. Golden pairs are in
  [kosync.json](../../internal/httpapi/testdata/kosync.json). Success/error envelopes
  were checked against upstream
  [controller](https://github.com/koreader/koreader-sync-server/blob/46ef6b84a3930b3f0265efac74899f2256c158f1/app/controllers/1/syncs_controller.lua)
  and [error definitions](https://github.com/koreader/koreader-sync-server/blob/46ef6b84a3930b3f0265efac74899f2256c158f1/config/errors.lua).
- `VerifyAppPassword` remains the only credential verifier. Missing, duplicate,
  malformed, mismatched, wrong-kind, revoked and disabled credentials return the same
  unauthorized response. A separate bounded auth rate limiter permits five failed
  attempts per client address in ten minutes; successful verification resets it.
  Throttling returns 429 with `Retry-After: 600` and a protocol error envelope.
- PUT accepts a 32 KiB body, a 1-64 byte ASCII alphanumeric/underscore document,
  a nonempty progress string up to 8 KiB, a required percentage in `[0,1]`, a required
  device string up to 128 bytes and an optional device ID up to 128 bytes. Invalid UTF-8,
  NULs, unusable known PDF/CBZ pages and locators exceeding R1's encoded size limit are
  rejected. Raw timestamps are server milliseconds internally and numeric seconds on
  the wire; client timestamp fields are not trusted.
- Raw progress, the existing R1 `PushTx` validation/LWW/revision write and derived
  sessions commit together. Unknown and inaccessible documents only store raw records.
  GET reads one snapshot and never maps inaccessible catalog state. Exact page locators
  require the same physical file, and synthesized responses never overwrite raw rows.
- Sessions use a stable device/document/file fingerprint in UUIDv7 random bits so they
  survive adapter restarts without a migration. Device ID identifies a device; its name
  is the fallback when the ID is absent. Exactly fifteen minutes extends a session;
  greater gaps start another. Active seconds are the elapsed interval between pushes.
- **Device availability:** no real KOReader device/model was available; no on-device
  EPUB/FB2/MOBI/AZW3 XPointer compatibility result is claimed. `Options.ChapterXPointer`
  is disabled in application wiring. For newer web progress, retain the last raw
  XPointer while returning the web percentage, timestamp and `PandaLibrary Web` device.
  With no prior XPointer, return `{}` rather than fabricate one. Chapter synthesis is
  implemented and tested behind that option for later real-device validation.
  PDF/CBZ exact-page synthesis remains enabled.
- User setup, including entering the existing app password without its display hyphens,
  is documented in [README](../../README.md#koreader-progress-sync-k1).

### Validation

- Passed: `task sqlc:check`, `task build`, uncached
  `go test ./internal/kosync ./internal/httpapi ./internal/reading ./internal/app`,
  scoped `staticcheck` for those four packages, and `git diff --check`.
- Adapter coverage: 84.1% (`go test -count=1 -cover ./internal/kosync`).
- `task test` passed once during implementation. Later runs encountered concurrent
  M1's cover-only apply test failure and transient J1 maintenance signature errors
  during lint; all K1-related packages continued to pass.
- The final `task lint` / `task test` run was blocked by a concurrent M1 syntax error:
  `internal/metadata/providers_test.go:193:8: expected '(', found TestProviderGetAndHardcoverEncodedResults`.
  No unrelated task code was changed to mask those failures. Re-run the full gates
  after those concurrent changes settle before marking K1 Done.
- Re-run (2026-11-03, after concurrent changes settled): `task sqlc:check`,
  `task build`, `task lint`, `task test`, uncached
  `go test -count=1 ./internal/kosync ./internal/httpapi ./internal/reading ./internal/app`,
  and `git diff --check` all pass. K1 marked Done.
