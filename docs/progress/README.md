# Progress

Status values: `Not started` · `Prompt drafted` · `Ready` · `In progress` · `Review` ·
`Done` · `Blocked (reason)`.

Rules: each session edits only its own task's row and appends to the log. Plan:
[implementation-plan.md](../plans/implementation-plan.md).

## Board

| Step | Task | Title | Deps | Prompt | Status | Branch | Notes |
|---|---|---|---|---|---|---|---|
| 1 | F1 🔒 | Repository scaffold | — | [F1-repo-scaffold.md](../prompts/F1-repo-scaffold.md) | Prompt drafted | | |
| 2 | F2 | Database and migration runner | F1 | — | Not started | | |
| 2 | F3 | Web scaffold | F1 | — | Not started | | |
| 2 | X1 | Extraction core, EPUB, covers | F1 | — | Not started | | |
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

- 2026-11-02 — F1 — Prompt drafted; awaiting review before starting the scaffold.
- 2026-11-02 — docs — Open questions settled (all recommendations accepted). ADR-0001, 0003
  and 0004 accepted. Plan reorganised into 11 numbered steps of at most 4 parallel
  sessions; the gates F1, F4, A1, C1 and Q1 each run alone. X2/X3 run in step 6 so all
  formats exist before the reader UI (W2). Next: write the F1 prompt.

- 2026-11-02 — docs — Design complete. Schema moved to
  `internal/db/migrations/00001_init.sql`; docs restructured into architecture, decisions,
  plans, prompts and progress; v1 plan written. No code yet.
