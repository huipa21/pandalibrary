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
| 3 | F4 🔒 | Server skeleton | F2, F3 | — | Not started | | |
| 4 | A1 🔒 | Auth vertical slice | F4 | — | Not started | | |
| 5 | C1 🔒 | Catalog core | A1 | — | Not started | | |
| 6 | R1 | Reading and sync API | C1 | — | Not started | | |
| 6 | W1 | Library UI | C1 | — | Not started | | |
| 6 | X2 | PDF and CBZ extractors | X1 | — | Not started | | |
| 6 | X3 | MOBI/AZW3 and FB2 extractors | X1 | — | Not started | | |
| 7 | W2 | Reader UI | R1, W1 | — | Not started | | |
| 7 | I1 | Importer | C1, X1 | — | Not started | | |
| 7 | S1 | Search | C1 | — | Not started | | |
| 7 | SH1 | Shelves | C1 | — | Not started | | |
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
