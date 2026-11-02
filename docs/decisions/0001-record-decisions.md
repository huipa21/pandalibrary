# ADR-0001: Record decisions as ADRs

- Status: Accepted
- Date: 2026-11-02

## Context

The project is designed in chat sessions and built by several agent sessions, some running
in parallel. Each session starts without the earlier chat context. If the reasons behind
choices are not written down, later sessions re-open settled questions or quietly break
them.

## Decision

Keep short Architecture Decision Records in `docs/decisions/`, numbered sequentially, one
decision per file, using `template.md`. Accepted ADRs are not edited; a change of mind is a
new ADR that supersedes the old one.

## Alternatives considered

- Only an architecture document: it shows the current state but loses the "why" and the
  rejected options.
- Decisions in commit messages or PRs: hard for an agent to find.

## Consequences

Agents read `docs/decisions/README.md` before working. A prompt that would contradict an
accepted ADR must stop and say so instead of implementing it.
