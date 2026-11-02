# ADR-0005: Offline sync with per-row last-write-wins and a global rev counter

- Status: Accepted
- Date: 2026-11-02

## Context

The PWA must keep reading progress, highlights, notes, statuses and settings in sync
across devices, including edits made offline. This is personal data, usually edited by one
person at a time.

## Decision

- Clients queue mutations in an IndexedDB outbox and push them in batches.
- The server applies each row with last-write-wins on `updated_at`. The client time is
  clamped to the server's current time, so a device whose clock is ahead cannot win
  forever. Deletes are tombstones.
- Every applied write takes `rev` from the single-row `sync_counter`. A pull returns the
  rows with `cursor < rev ≤ hi` inside one read transaction.
- Client-created rows use UUIDv7 ids, so pushes are idempotent.

Details: [architecture/system.md](../architecture/system.md) §10 and
[database.md](../architecture/database.md) §6.

## Alternatives considered

- CRDTs: they solve concurrent edits to one note, which is rare here, at a large cost in
  complexity.
- Timestamp-based pull cursors: clock skew and equal timestamps lose rows; a commit-order
  rev does not.

## Consequences

- When two devices edit the same note offline, one edit is lost. This is accepted for v1.
- Tombstones are purged after 180 days. A device offline longer than that does a full
  resync.
