# Architecture Decision Records

Each significant decision is one file: `NNNN-short-title.md`, using
[template.md](./template.md). Records are never rewritten after they are accepted. A
decision that changes gets a new ADR that marks the old one `Superseded by ADR-NNNN`.

Write an ADR when a choice:

- is hard to reverse (storage format, protocol, public URL, migration strategy);
- has reasonable alternatives that someone will ask about later;
- changes how agents and humans work on the repo.

Smaller choices go in [architecture](../architecture/system.md) with a one-line rationale.

| # | Title | Status |
|---|---|---|
| [0001](./0001-record-decisions.md) | Record decisions as ADRs | Accepted |
| [0002](./0002-single-binary-go-sqlite.md) | Single Go binary with embedded SPA and SQLite | Accepted |
| [0003](./0003-auto-applied-migrations.md) | Schema lives in migrations; pending schema and data migrations auto-apply at startup | Accepted |
| [0004](./0004-docs-structure-and-agent-workflow.md) | Docs structure and prompt-first, plan-driven agent workflow | Accepted |
| [0005](./0005-offline-sync-lww.md) | Offline sync with per-row last-write-wins and a global rev counter | Accepted |
| [0006](./0006-koreader-sync-compat.md) | KOReader sync via the kosync protocol and partial-MD5 file identity | Accepted |
| [0007](./0007-public-reviews-private-notes.md) | Public reviews are separate from private notes | Accepted |
