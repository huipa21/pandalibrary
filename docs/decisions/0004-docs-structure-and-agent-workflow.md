# ADR-0004: Docs structure and prompt-first, plan-driven agent workflow

- Status: Accepted
- Date: 2026-11-02

## Context

Implementation is done by AI agent sessions. Some tasks can run at the same time in
separate sessions; others must finish before the next one starts. Each session needs
enough written context to work without the design chat.

## Decision

`docs/` has five folders:

| Folder | Holds | Changes when |
|---|---|---|
| `architecture/` | Current design: system, database, migrations | The design changes (kept current, not historical) |
| `decisions/` | ADRs: why, and what was rejected | A significant decision is made or reversed |
| `plans/` | Task breakdown with dependencies, grouped into numbered steps (serial gates and parallel tasks) | Scope or ordering changes |
| `prompts/` | One self-contained implementation prompt per plan task | A task is about to start |
| `progress/` | Status board and dated log | A task starts, finishes, or is blocked |

Workflow for each task:

The plan is a list of **numbered steps**. Each step lists the tasks that can run in
parallel (at most 4, matching the 3–4 sessions the owner runs at once). A step starts only
after every task of the previous step is merged. A step with one task is a serial gate.

For each task in the current step:

1. **Write the prompt.** On request, an agent writes `prompts/<task-id>-<slug>.md` from the
   template, using the plan entry, architecture and ADRs. A human reviews it.
2. **Implement.** A new agent session is started with that prompt only. Tasks in the same
   step run in separate sessions, each on its own branch and git worktree.
3. **Record.** The implementing session updates `progress/`, and updates `architecture/`
   or adds an ADR if the design changed.

## Alternatives considered

- One large design document: it cannot be handed out per task, and status and decisions
  get mixed with design.
- An issue tracker: it sits outside the repo, so agents may not see it.

## Consequences

- The plan must state each task's dependencies, owned files and whether it owns a
  migration, so parallel sessions do not collide.
- Prompts are written just in time, so they can reflect what earlier tasks actually
  built.
