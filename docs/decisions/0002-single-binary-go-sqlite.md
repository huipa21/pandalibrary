# ADR-0002: Single Go binary with embedded SPA and SQLite

- Status: Accepted
- Date: 2026-11-02

## Context

PandaLibrary is a self-hosted ebook library for a household or a small group. It must be
easy to run on a NAS or a small VPS, back up, and upgrade.

## Decision

- Backend: Go with chi, SQLite through the pure-Go `modernc.org/sqlite` driver (WAL, one
  writer connection, N reader connections), sqlc for queries, goose for migrations.
- Frontend: a SvelteKit (Svelte 5) static SPA built with `adapter-static` and embedded in
  the binary with `go:embed`.
- Files on local disk, content-addressed by SHA-256.
- Ship as one static binary (`CGO_ENABLED=0`) and a `FROM scratch` Docker image.

Full details: [architecture/system.md](../architecture/system.md) §1.

## Alternatives considered

- PostgreSQL: an extra service to run and back up, with no benefit at this scale.
- cgo `mattn/go-sqlite3`: faster in some cases, but it breaks easy cross-compiling and the
  scratch image.
- Server-rendered UI: offline reading and the in-browser readers need a rich client
  anyway.

## Consequences

- There is a single writer, so slow work (hashing, parsing, provider HTTP calls) must
  happen outside write transactions.
- sqlc's SQLite parser has limits; the workarounds are in
  [database.md](../architecture/database.md) §7.
