# <ID>: <Title>

- Status: Draft | Ready | In progress | Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § <ID>
- Depends on (merged): <IDs>
- Can run in parallel with: <IDs>
- Branch / worktree: `task/<id>` in `..\pandalibrary-<id>`
- Migration: no | yes (only if the plan says so)

## Read first

- [architecture/system.md](../architecture/system.md) §<n>
- [architecture/database.md](../architecture/database.md) §<n>
- ADRs: <list>
- Existing code to build on: <packages/files from merged dependencies>

## Goal

One paragraph: what exists when this task is done and why it matters.

## Scope

**Owns (create/modify freely):**
- `<path>`

**Shared files (append-only, see plan §4):**
- `<path>` — what to add

**Must not touch:**
- `<path>` — owned by <ID>

## Requirements

Numbered, concrete, testable. Include APIs (method, path, request/response shape), queries,
error cases, limits and security rules.

1. …

## Out of scope

- … (and which task covers it)

## Acceptance criteria

- [ ] …
- [ ] Tests: <what must be covered>
- [ ] `task lint test` passes (plus `pnpm check test` for web tasks)

## Validation commands

```powershell
task lint test
```

## Hand-off

- Update this prompt's status, and this task's row and log entry in
  [progress/README.md](../progress/README.md).
- Update the architecture docs, or add an ADR, if the design changed. Note any follow-ups
  for dependent tasks.
