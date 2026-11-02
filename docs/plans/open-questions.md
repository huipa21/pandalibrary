# Open questions (resolved)

Status: **resolved 2026-11-02**. Every recommended proposal was accepted. ADR-0001,
ADR-0003 and ADR-0004 are `Accepted`, and [implementation-plan.md](./implementation-plan.md)
is final. This file is kept as the record of what was decided.

## Migrations ([ADR-0003](../decisions/0003-auto-applied-migrations.md), [migrations.md](../architecture/migrations.md))

| # | Question | Proposal | Alternatives | Answer |
|---|---|---|---|---|
| M1 | Where does the schema live? | `internal/db/migrations/00001_init.sql`, embedded in the binary | Top-level `migrations/` folder | Accepted (recommended) |
| M2 | Migration file naming | Sequential `00002_…`. Only one in-progress task may add a migration at a time | Timestamps: no number clashes between parallel branches, but merge order can differ from file order | Accepted (recommended) |
| M3 | Auto-apply on startup | On by default. Back up the DB first, apply each migration in its own transaction, then run integrity checks. `PANDA_AUTO_MIGRATE=false` requires running `pandalibrary migrate up` by hand | Off by default; always manual | Accepted (recommended) |
| M4 | How data migrations run | SQL backfills; Go data migrations using raw SQL; resumable background jobs for slow file work | SQL only; or all data work as background jobs | Accepted (recommended) |
| M5 | Database newer than the binary / rollback | Refuse to start. In production, roll back by restoring the pre-migration backup with the previous binary. Goose `Down` sections exist only for development (`migrate down-to`) | Supported production down-migrations | Accepted (recommended) |
| M6 | Changing a merged migration | Not allowed. `migrations.sum` checksums plus a test enforce this | Allowed until the first release | Accepted (recommended) |
| M7 | Pre-migration backup | `VACUUM INTO backups/…` before applying migrations, on by default (`PANDA_MIGRATE_BACKUP`), kept under the normal backup retention | Separate retention for migration backups; or off by default | Accepted (recommended) |

## Workflow and docs ([ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md))

| # | Question | Proposal | Alternatives | Answer |
|---|---|---|---|---|
| W1 | Docs layout | `architecture/`, `decisions/`, `plans/`, `prompts/`, `progress/` | — | Accepted (recommended) |
| W2 | Prompt lifecycle | You ask for a prompt → it is written to `prompts/<task>.md` → you review it → a new session implements it | Write all prompts up front | Accepted (recommended) |
| W3 | Isolating parallel sessions | One git branch and worktree per task. Each task changes only the paths it owns | Shared working copy | Accepted (recommended) |
| W4 | Shared files (route list, app wiring, i18n, `go.sum`, pnpm lock) | Add-only edits; merge conflicts resolved by the second session to merge | One owner task per shared file | Accepted (recommended) |
| W5 | Who updates `progress/` | Each session edits only its own row and appends to the log | Only you update it | Accepted (recommended) |

## Plan ([implementation-plan.md](./implementation-plan.md))

| # | Question | Proposal | Answer |
|---|---|---|---|
| P1 | Serial gates (run alone, merge first) | F1 repo setup, F4 server skeleton, A1 auth, C1 catalog core, Q1 release | Accepted. Each gate is its own step (F1 = 1, F4 = 3, A1 = 4, C1 = 5, Q1 = 11) |
| P2 | Parallel grouping | Group tasks so independent ones run in separate sessions | Accepted, reshaped into 11 numbered steps of at most 4 parallel tasks (see plan §3) |
| P3 | How many sessions you will actually run at once | Ask the user | 3–4 sessions at once. Each step has at most 4 tasks |
| P4 | Task size and split | 27 tasks; see the plan for scope of each | Accepted (recommended) |
| P5 | First task | F1 repository scaffold | Accepted (recommended) |
