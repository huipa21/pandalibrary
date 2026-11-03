# W3: Offline PWA

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § W3
- Depends on (merged): W2
- Can run in parallel with: K1, M1, J1
- Branch / worktree: `task/w3` in `..\pandalibrary-w3`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 5–6, 10, 12, 15–16
- [architecture/database.md](../architecture/database.md) §§5–6
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md) and
  [ADR-0005](../decisions/0005-offline-sync-lww.md)
- W2's merged reader and R1 sync client in `web/src/lib/reader/`, the authenticated app
  shell/session state, W1's book detail route and file DTOs, existing Vitest/Playwright
  setup, and the corresponding Go sync DTOs in `internal/reading/`

## Goal

Let a signed-in user explicitly save books for offline reading and continue making reading
progress and annotation changes offline. Persist changes in a durable IndexedDB outbox and
reconcile them through the existing R1 push/pull contract without changing online reader
behavior or introducing a second synchronization protocol.

## Scope

**Owns (create/modify freely):**
- `web/src/service-worker.ts`
- `web/src/lib/sync/**`
- Offline download and storage-settings UI, including the limited integration needed in
  `web/src/routes/books/[id]/`, `web/src/routes/read/`, and `web/src/routes/settings/`
- Focused frontend tests and fixtures alongside owned source files

**Shared files (append-only, see plan §4):**
- `web/messages/en.json` and `web/messages/zh.json` — add matching `offline.*` keys only
- `web/package.json` / `web/pnpm-lock.yaml` — add only justified dependencies; preserve
  both sides when resolving lockfile conflicts
- [progress/README.md](../progress/README.md) — edit only the W3 row and append a W3 log

**Must not touch:**
- Backend routes, database schema, R1 validation/LWW semantics, or auth behavior
- W2 reader contracts, annotations, or online progress behavior beyond the minimal
  integration required to open a cached file
- Generated `web/src/lib/paraglide/**`

## Requirements

1. Implement a typed IndexedDB outbox for the existing R1 mutation shape. Preserve
   UUIDv7 IDs, natural keys, `updated_at`, deletes/tombstones, and idempotent retry
   behavior. Push no more than 500 mutations per request, inspect every returned result,
   and never silently discard rejected, stale, or unsent mutations.
2. Implement pull using the R1 cursor/rev contract. Advance the locally stored cursor only
   after the complete pull has been persisted; tolerate harmless rev gaps and resume
   after interruption. Do not invent a timestamp cursor, server endpoint, or conflict rule.
3. Run push then pull on app start, `online`, transition to visible, every 60 seconds while
   a reader is open, and Background Sync when supported. Keep an explicit online retry
   path for browsers without Background Sync; do not claim a queued write reached the
   server until the server confirms it.
4. Add an explicit per-file "Download for offline" action. Cache the hash-versioned,
   same-origin file URL returned by the catalog API, plus the minimal book detail and
   cover needed for the offline UI. Validate URLs using the existing W2 safeguards; do
   not construct paths or cache arbitrary files.
5. Make cached book data and outbox state account-scoped using the authenticated user's
   stable identity. Never serve one account's cached book or API data to another account,
   or push one account's queued mutations while another account is signed in. Clear or
   isolate private cached data on logout/account change, and do not cache arbitrary
   authenticated API responses. Request persistent storage where supported and report
   storage usage.
6. Open an explicitly downloaded book from its cached `Blob` when offline; preserve the
   normal network path when online. Evict the cached book and its detail/cover when an
   authenticated request for it returns 403 or 404. Provide a deliberate per-book and
   all-books eviction action and handle browser storage eviction without success-shaped
   fallbacks.
7. Add accessible storage settings that explain offline storage, show quota/usage where
   supported, expose persistence status, and allow explicit eviction. Feature-detect
   browser APIs and present unavailable/failed states clearly.
8. Keep the service worker cache versioned and bounded to the app shell and explicitly
   downloaded books. Do not cache credentials, tokens, or arbitrary API responses; ensure
   offline navigation cannot bypass authentication or expose another user's data.
9. Localize every new user-visible string in English and Chinese. Add unit tests for
   outbox persistence/retry, partial push results, pull cursor atomicity, account isolation,
   and eviction. Add Playwright coverage proving offline progress queues, reconnect pushes
   and pulls it, and 403/404 evicts a downloaded book.

## Out of scope

- New backend endpoints, database tables, or changes to the sync protocol
- Background download of the entire library or automatic downloads
- Changing accepted LWW/tombstone semantics or W2 online reader features

## Acceptance criteria

- [x] Offline edits survive page reload and are pushed after reconnect using R1's contract.
- [x] The pull cursor advances only after a complete persisted pull.
- [x] Only explicitly downloaded, account-scoped books are available offline.
- [x] A 403/404 removes the corresponding cached book; storage settings support usage and
  explicit eviction.
- [x] Unit tests cover outbox, cursor, account isolation, and eviction behavior.
- [x] Playwright verifies offline progress -> reconnect -> synced and 403/404 eviction.
- [x] `pnpm --dir web check`, `pnpm --dir web test`, `pnpm --dir web build`, and
  `pnpm --dir web test:e2e` pass.

## Validation commands

```powershell
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:e2e
```

## Hand-off

- Update this prompt's status and the W3 row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record browser limitations and any cache or cursor compatibility decisions. Update
  architecture docs or add an ADR only if the accepted design changes.

### Implemented hand-off (2026-11-03)

- IndexedDB database `pandalibrary-offline`, version 1, owns account-keyed book detail,
  cover and file Blobs, pulled rows, cursors and durable outbox sequences. Private
  downloads publish/evict in one transaction instead of spanning Cache Storage and
  IndexedDB. This compatibility choice is reflected in architecture section 10.
- Mutations preserve UUIDv7 IDs, natural keys, timestamps and tombstones. Batches are
  bounded to 500 items and 1,900,000 encoded bytes. Missing, duplicate or invalid results
  leave unacknowledged writes intact; stale/rejected writes require explicit retry or
  discard. Applied writes remain replayable until the pull/cursor transaction commits.
  Reactive reader values are converted to plain JSON before IndexedDB cloning.
- The R1 revision cursor advances with the complete persisted snapshot. Harmless rev
  gaps are accepted. A local last-successful-pull age of 180 days requests `cursor=0`
  and atomically replaces the old snapshot; no new endpoint/watermark field is assumed.
- Web Locks serialize sync with login/logout in tabs and the worker. Online sync checks
  `/auth/me` before batches and pulls; every private transaction checks the active user.
  Logout disables remembered offline access, while isolated pending changes remain for
  that same account's next sign-in. Offline access trusts the previously authenticated
  device; server-side revocations cannot be learned until a network request succeeds.
- Service worker precaching is limited to versioned public assets and the shell. Absolute
  asset URLs and public-asset-only Vary handling support offline nested navigation.
  Book file fetches use `no-store`; no private response is available through the worker.
- HTTPS/localhost, IndexedDB and Web Locks are needed for the offline workflow. Without
  storage/locking support the UI reports unavailability and keeps online reading.
  Background Sync and persistence/quota APIs are feature-detected; app-open, online,
  visible, 60-second reader and explicit retries work without Background Sync. Browsers
  may deny persistence or evict data, which is surfaced as missing/unavailable storage.
- Validation: `pnpm --dir web check` (zero diagnostics), `pnpm --dir web test` (53 passing),
  `pnpm --dir web build`, and `pnpm --dir web test:e2e -- --workers=2` (21 passing).
  Existing reader/auth/catalog fixtures now answer the R1 pull contract. No backend
  routes, validation, LWW semantics, database schema or generated Paraglide sources changed.
