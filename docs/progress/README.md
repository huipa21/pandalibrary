# Progress

Status values: `Not started` · `Prompt drafted` · `Ready` · `In progress` · `Review` ·
`Done` · `Blocked (reason)`.

Rules: each session edits only its own task's row and appends to the log. Plan:
[implementation-plan.md](../plans/implementation-plan.md).

## Board

| Step | Task | Title | Deps | Prompt | Status | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 1 | F1 🔒 | Repository scaffold | — | [F1-repo-scaffold.md](../prompts/F1-repo-scaffold.md) | Done | `task/f1` | Merged into master after F2/F3/X1 |
| 2 | F2 | Database and migration runner | F1 | [F2-db-migrations.md](../prompts/F2-db-migrations.md) | Review | | Full lint/test wait for F3 web build assets |
| 2 | F3 | Web scaffold | F1 | [F3-web-scaffold.md](../prompts/F3-web-scaffold.md) | Done | | Static fallback embedded; F4 must route SPA paths to it |
| 2 | X1 | Extraction core, EPUB, covers | F1 | [X1-extraction-epub-covers.md](../prompts/X1-extraction-epub-covers.md) | Review | | Full lint blocked by unrelated F2 diagnostics |
| 3 | F4 🔒 | Server skeleton | F2, F3 | [F4-server-skeleton.md](../prompts/F4-server-skeleton.md) | Done | `master` | Server, health, SPA, middleware, and shutdown; F2/X1 remain in review |
| 4 | A1 🔒 | Auth vertical slice | F4 | [A1-auth-vertical-slice.md](../prompts/A1-auth-vertical-slice.md) | Done | `master` | Auth setup, sessions, app passwords, CLI, and web flows; checks pass |
| 5 | C1 🔒 | Catalog core | A1 | [C1-catalog-core.md](../prompts/C1-catalog-core.md) | Done | `master` | Catalog, ACLs, metadata, media, and FTS; F2/X1 remain in review |
| 6 | R1 | Reading and sync API | C1 | [R1-reading-sync-api.md](../prompts/R1-reading-sync-api.md) | Done | `master` | Push/pull DTO and schema deletion limits recorded in prompt hand-off |
| 6 | W1 | Library UI | C1 | [W1-library-ui.md](../prompts/W1-library-ui.md) | Done | `master` | Bilingual catalog browsing, filters, keyset paging and details; frontend checks and browser tests pass |
| 6 | X2 | PDF and CBZ extractors | X1 | [X2-pdf-cbz-extractors.md](../prompts/X2-pdf-cbz-extractors.md) | Done | `master` | PDF/CBZ registration and fixture tests; pdfcpu v0.16.4 |
| 6 | X3 | MOBI/AZW3 and FB2 extractors | X1 | [X3-mobi-fb2-extractors.md](../prompts/X3-mobi-fb2-extractors.md) | Blocked (X1 FB2 sniffing) | `master` | Plain CP1251 and BOM FB2 cannot reach the registered extractor |
| 7 | W2 | Reader UI | R1, W1 | [W2-reader-ui.md](../prompts/W2-reader-ui.md) | Done | `master` | Seven-format bilingual reader, R1 progress/annotations/settings/sessions, isolated book content; frontend checks and browser tests pass |
| 7 | I1 | Importer | C1, X1 | [I1-importer.md](../prompts/I1-importer.md) | Done | `master` | Durable uploads/drop imports, two workers, recovery, formats/FTS/covers; required Go gates pass; X1/X3 BOM/CP1251 plain-FB2 blocker unchanged |
| 7 | S1 | Search | C1 | [S1-search.md](../prompts/S1-search.md) | Done | `master` | Authenticated FTS/short-query search with visibility and query-bound pagination; checks pass |
| 7 | SH1 | Shelves | C1 | [SH1-shelves.md](../prompts/SH1-shelves.md) | Done | `master` | Private/shared shelves, visibility-filtered manual ordering, and paged APIs; checks pass |
| 8 | W3 | Offline PWA | W2 | — | Not started | | |
| 8 | K1 | KOReader sync | R1, I1 | — | Not started | | Needs a real device test |
| 8 | M1 | Metadata providers | C1, X1 | — | Not started | | |
| 8 | J1 | Maintenance jobs | I1, R1 | — | Not started | | |
| 9 | ST1 | Stats API | R1 | — | Not started | | |
| 9 | E1 | Notes export | R1 | — | Not started | | |
| 9 | O1 | OPDS | S1, SH1 | — | Not started | | |
| 9 | W4 | Search and shelves UI | S1, SH1, W1 | — | Not started | | |
| 10 | W7 | Stats, notes and export UI | ST1, E1, W2 | — | Not started | | |
| 10 | W5 | Admin UI | I1, M1, W1, J1 | — | Not started | | |
| 10 | W6 | Metadata merge UI | M1, W1 | — | Not started | | |
| 11 | Q1 🔒 | Release and end-to-end | all | — | Not started | | |

## Log

Newest first. Format: `YYYY-MM-DD — <task> — what happened (decisions, blockers, follow-ups)`.

- 2026-11-03 — W2 — Implemented the seven-format browser reader and reader-owned chooser,
  accessible English/Chinese controls, R1 progress restore/debounced saves, highlights,
  sanitized CodeMirror Markdown notes, settings, and active reading sessions with explicit
  retry. Foliate sections are sanitized and receive a script-denying CSP; direct Blob
  capture avoids weakening the host CSP for intermediate blob fetches. PDF.js assets are
  bundled same-origin. `pnpm --dir web check`, `test` (30 tests), `build`, and the full
  Playwright suite (16 tests, isolated port 4193) pass. Generated fixtures exercise all
  seven formats including genuine KF8/AZW3; the malicious EPUB covers inline/external
  same-origin scripts and event handlers. No offline/PWA work was added; W3 constraints
  and in-memory-only retry behavior are recorded in the W2 prompt.

- 2026-11-03 — I1 — Implemented streaming administrator uploads, add-format and bounded
  job history; safe content-addressed book writes with one-pass SHA-256/KOReader hashes;
  two durable SQLite-backed workers, transactional catalog/FTS writes, concurrent dedupe,
  cover publication, restart manifests, and graceful cancellation. Added fsnotify startup
  and live scans, three-second stability checks, per-library drop routing, optional
  `PANDA_DROP_POLL`, and safe duplicate/failure outcomes. `task sqlc:check`, `task build`,
  `task lint`, and `task test` pass. API/lifecycle and J1 spool-retention contracts are in
  the I1 prompt. X1/X3 Windows-1251 and BOM plain-FB2 sniffing remains an explicit
  follow-up; extractor/sniffer code and migrations were not changed.

- 2026-11-03 — S1 — Implemented visibility-filtered trigram and short-query book search,
  deterministic ranked pagination, and an authenticated API. Added SQLite, catalog
  visibility, application-mount and HTTP tests; `task sqlc:check`, `task build`,
  `task lint`, and `task test` pass. The prompt records the W4/O1 result and cursor contract.
- 2026-11-03 — SH1 — Implemented private/shared shelves, transactional manual ordering and
  viewer-filtered counts and book pagination. Added authorization, visibility, concurrency,
  rollback, and HTTP tests; `task sqlc:check`, `task build`, `task lint`, and `task test`
  pass. No migration was needed; the prompt records the O1/W4 response and cursor contract.
- 2026-11-03 — docs — Drafted the Step 7 prompts (W2, I1, S1, SH1) from the accepted plan,
  current architecture, and merged R1/C1/extractor interfaces. I1 explicitly records the
  known X3 plain-FB2 sniffing blocker; prompts await review.
- 2026-11-03 — X3 — Implemented MOBI/AZW3 and FB2/FBZ extractors with DRM detection,
  bounded metadata/covers, generated fixtures, and registration tests. `task build`,
  `task lint`, and `task test` pass. Plain FB2 registry dispatch for Windows-1251 and
  UTF-8 with a BOM is blocked by X1's out-of-scope sniffer; direct extraction and FBZ
  dispatch work, and two registry cases are explicitly skipped pending an X1 fix.
- 2026-11-03 — W1 — Implemented the bilingual catalog UI with accessible library browsing,
  entity indexes/details, URL-backed book filters and sort, server-cursor paging, book
  details and hash-versioned downloads. `pnpm --dir web check`, `test`, `build`, and the
  full Playwright suite pass; browser validation used port 4193 because 4173 was occupied.
- 2026-11-03 — R1 — Implemented the user-scoped reading/settings APIs, transactional LWW
  push/pull, append-only sessions, annotation tombstones/FTS, and visibility-filtered search.
  Added SQLite service and authenticated HTTP tests; `task sqlc:check`, `task build`,
  `task lint`, and `task test` pass. No migration was needed.
- 2026-11-03 — X2 — Implemented bounded PDF metadata/page-count extraction with pdfcpu
  v0.16.4 and ComicInfo/cover extraction for CBZ; added generated-fixture, error, and
  registry tests. `task build`, `task lint`, and `task test` pass. I1 can register with
  `pdf.Register` and `cbz.Register`; no global registry wiring was added.
- 2026-11-03 — docs — Drafted all four Step 6 prompts (R1, W1, X2, X3) from the accepted
  plan and the current C1, X1, database, extractor, and web interfaces. Prompts are ready
  for review; implementation remains gated on review/merge of the prior work.
- 2026-11-03 — C1 — Implemented the visibility-filtered catalog, library ACLs, metadata
  and FTS transactions, and authorized file/cover serving. `task sqlc:check`, `task
  build`, `task lint`, and time-bounded `task test` pass; F2/X1 remain in review.
- 2026-11-03 — C1 — Started implementing the catalog core in the current `master`
  worktree at the user's request.
- 2026-11-02 — C1 — Drafted the catalog-core prompt from the accepted plan and merged
  auth, server, database, and cover interfaces. Awaiting review; implementation has not
  started.
- 2026-11-02 — A1 — Started implementing the authentication vertical slice on `master`.
- 2026-11-02 — A1 — Implemented the authentication vertical slice: setup, sessions,
  profile and app-password APIs, secure user CLI commands, and bilingual web flows.
  Go tests/build, sqlc checks, web checks/tests/build, lint, and isolated Playwright
  setup/login/app-password flows pass.
- 2026-11-02 — A1 — Drafted the authentication vertical-slice prompt from the accepted
  plan and the merged F4/F3/F2 interfaces. Prompt is ready for review; implementation has
  not started.
- 2026-11-02 — F4 — Implemented configuration, migration-gated startup, the chi router,
  healthcheck, embedded SPA, trusted-proxy/security middleware, and scheduler lifecycle.
  The SPA fallback needs an inline SvelteKit bootstrap, so the server uses an HTML
  tokenizer and a fresh CSP nonce per response; the architecture now records this.
  `task web:build`, `task build`, `task lint`, `task test`, and `task sqlc:check` pass;
  focused Linux race tests and live CLI/browser checks pass. A1 can add `httpapi.Mount`
  callbacks, apply the supplied cookie-protection middleware, and use the resolved
  client IP/scheme helpers; app wiring owns startup and shutdown.
- 2026-11-02 — F4 — Started on `master` at the user's request. The existing Go lint and
  test tasks pass with the F3 web assets built.
- 2026-11-02 — F4 — Drafted the server-skeleton prompt from the accepted plan and the
  current F2/F3 interfaces. Implementation remains gated on step 2 being fully merged.
- 2026-11-02 — F1 — Merged `task/f1` into master after F2, F3 and X1 had landed with
  their own minimal Go plumbing. Kept the F2 CLI (real `migrate` commands) and tests,
  module requirements, and the F3 CI web steps; added F1's package docs, editor/ignore
  rules, Task descriptions with the inline CGO override, and pinned tool versions.
- 2026-11-02 — F3 — Added the SvelteKit SPA scaffold, Tailwind/shadcn setup, English and
  Chinese Paraglide messages, typed API client/navigation foundation, Playwright config,
  Vitest coverage, and Go embed package. Frontend check/test/build and `go test ./...`
  pass; CI builds web assets in each independent job. The generated fallback is ready for
  F4 to serve on client-side routes.
- 2026-11-02 — F1 — Completed the Go 1.27 scaffold with explicit failing CLI stubs,
  subprocess dispatch/exit tests, documented internal packages, portable Task targets,
  baseline editor/ignore settings, and Go-only CI with pinned Task/staticcheck tools.
  `task build`, `task lint`, and `task test` passed on Windows and Linux; actionlint
  passed. The hosted workflow awaits a push (no remote configured). No runtime
  dependencies, migration changes, web files, or design changes were introduced.
  F2/F3/F4 retain ownership of database, web, and server implementation; merge F1
  before starting step 2.
- 2026-11-02 — F1 — Started the repository scaffold on `task/f1`.
- 2026-11-02 — F1 — Prompt drafted; awaiting review before starting the scaffold.
- 2026-11-02 — F2 — Implemented the SQLite writer/reader pools, migration runner, checksum
  verification, sqlc generation, operator commands, and migration tests. `task build`,
  `task sqlc`, `task sqlc:check`, F2-local tests, vet, and staticcheck pass. Full `task
  lint` and `task test` are blocked by the concurrently added `web/embed.go` requiring
  missing `web/build` assets. F1 was not present on master, so minimal Go/module/task/CLI
  plumbing was added as a prerequisite; F1 remains incomplete.
- 2026-11-02 — X1 — Implemented shared extraction types, safe ZIP sniffing/limits,
  timeout-and-recover registry, EPUB2/3 metadata and cover extraction, JPEG cover
  normalization, and KOReader partial MD5. `task build` and `task test` pass; X1-local
  vet/staticcheck pass. Repository `task lint` reports unrelated `internal/db/migrations/`
  diagnostics, so X1 is marked Review pending that shared validation.
- 2026-11-02 — docs — Drafted Step 2 prompts for F2, F3, and X1 from the accepted plan
  and architecture. Review and reconcile each against the merged F1 scaffold before
  starting those tasks.
- 2026-11-02 — docs — Open questions settled (all recommendations accepted). ADR-0001, 0003
  and 0004 accepted. Plan reorganised into 11 numbered steps of at most 4 parallel
  sessions; the gates F1, F4, A1, C1 and Q1 each run alone. X2/X3 run in step 6 so all
  formats exist before the reader UI (W2). Next: write the F1 prompt.

- 2026-11-02 — docs — Design complete. Schema moved to
  `internal/db/migrations/00001_init.sql`; docs restructured into architecture, decisions,
  plans, prompts and progress; v1 plan written. No code yet.
