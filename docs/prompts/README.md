# Prompts

One implementation prompt per plan task: `<task-id>-<slug>.md` (for example
`F2-db-migrations.md`). Prompts are written **just before** a task starts, so they can
reflect what earlier tasks actually built.

## Workflow

1. **Write:** ask an agent to "write the prompt for task <id>". It reads the plan entry,
   the architecture docs, the ADRs, `progress/README.md`, and the merged code of the task's
   dependencies, then fills in [_template.md](./_template.md).
2. **Review:** a human checks scope, owned paths and acceptance criteria. Set
   `Status: Ready`.
3. **Implement:** start a **new** agent session in the task's worktree and give it only
   "Implement docs/prompts/<file>". The prompt must be self-contained.
4. **Close:** the implementing session sets `Status: Done` in the prompt and updates
   `progress/README.md`.

Prompts are kept after completion as a record of what was asked.

## Index

| Task | Prompt | Status |
|---|---|---|
| F1 | [F1-repo-scaffold.md](./F1-repo-scaffold.md) | Draft |
