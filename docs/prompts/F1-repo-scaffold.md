# F1: Repository scaffold

- Status: Draft
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § F1
- Depends on (merged): none
- Can run in parallel with: none — serial gate
- Branch / worktree: `task/f1` in `..\pandalibrary-f1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§1–3
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md)
- [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5
- [progress/README.md](../progress/README.md)
- Existing repository root [README.md](../../README.md)

## Goal

Create the minimal, buildable Go repository foundation for PandaLibrary: a single Go
module with command stubs, the planned internal package layout, repeatable build/lint/test
tasks, and a Go-only CI workflow. This is scaffolding only; later tasks implement the
database, web client, server, and application behavior.

## Scope

**Owns (create/modify freely):**
- `go.mod`
- `cmd/pandalibrary/`
- `Taskfile.yml`
- `.gitignore`
- `.editorconfig`
- Go lint configuration needed for `staticcheck` and `go vet`
- `.github/workflows/ci.yml` (Go job only)
- Empty Go package directories with `doc.go` as listed in `architecture/system.md` §3
- Root `README.md`, only as needed to document the scaffold commands and assumptions

**Shared files (append-only, see plan §4):**
- None

**Must not touch:**
- `internal/db/migrations/00001_init.sql` or any other migration; `Migration: no`
- `docs/architecture/`, `docs/decisions/`, or the implementation plan unless the
  scaffold exposes a genuine design inconsistency; report it rather than silently
  changing the design
- `web/` or any web toolchain/configuration
- Future feature implementation (database, HTTP server, auth, extraction, etc.)

## Requirements

1. Establish one Go module for this repository. Use a canonical module path if repository
   metadata provides one; otherwise use `pandalibrary` as the local module path and keep
   all package imports consistent. Align the Go version declared in `go.mod` and CI with
   the Go toolchain used by the project.
2. Add `cmd/pandalibrary` with a `main` entry point and stubs for the planned
   `serve` (default), `migrate`, `healthcheck`, and `user create|reset-password`
   commands. Stubs must clearly report that the command is not implemented and exit
   non-zero; do not make them appear to succeed. Add tests for default dispatch, each
   recognized stub, and unknown-command handling. Do not add a CLI framework unless it
   is necessary for these stubs.
3. Add `doc.go` files for the empty Go packages in the layout in
   `architecture/system.md` §3. Do not create placeholder files in frontend directories
   or migration/provider subdirectories that are not Go packages yet.
4. Add a `Taskfile.yml` with independent `build`, `lint`, and `test` tasks:
   - `build` builds `cmd/pandalibrary` with `CGO_ENABLED=0`.
   - `lint` runs `go vet ./...` and `staticcheck ./...`.
   - `test` runs `go test ./...`.
   Keep task commands portable across Windows and CI; avoid shell-specific command
   chaining or hard-coded executable paths. Document any required local tool such as
   Task or staticcheck.
5. Add `.editorconfig` and `.gitignore` with only relevant baseline settings/artifacts.
   Ignore Go build/test outputs and local runtime data, without ignoring source,
   migrations, or future web source.
6. Add `.github/workflows/ci.yml` with a Go job only. It must check out the repository,
   set up the declared Go version, install the task runner and pinned staticcheck
   version, and run `task build`, `task lint`, and `task test`. Do not add a web job.
7. Keep dependencies minimal. Do not add runtime dependencies just for stubs or
   introduce database/web dependencies owned by later tasks.
8. Document scaffold commands and local prerequisites in the root README, preserving
   its project description and links. Replace the stale “project not scaffolded yet”
   status with an accurate note that the repository scaffold exists but product
   implementation has not started.

## Out of scope

- Database access, schema changes, migration tooling, or `sqlc` (F2)
- SvelteKit/web scaffold and web CI (F3)
- HTTP server, configuration, middleware, or health behavior (F4)
- Authentication and user management behavior (A1)
- Release packaging, Docker, and end-to-end testing (Q1)

## Acceptance criteria

- [ ] `go.mod` and all scaffold packages compile without CGO.
- [ ] `cmd/pandalibrary` builds and each declared stub fails explicitly instead of
  returning success for unimplemented behavior; dispatch and error behavior are tested.
- [ ] `task build`, `task lint`, and `task test` pass from the repository root.
- [ ] The GitHub Actions Go job runs those same three tasks successfully.
- [ ] `staticcheck` and `go vet` cover all Go packages; no broad lint suppressions are
  added to make the skeleton pass.
- [ ] No migration or web files are added or changed.
- [ ] Update this prompt's status and F1's row and log entry in
  [progress/README.md](../progress/README.md) when implementation is complete.

## Validation commands

```powershell
task build
task lint
task test
```

## Hand-off

- During implementation, update F1's status and append a dated log entry in
  [progress/README.md](../progress/README.md); set this prompt to `Done` when complete.
- Update the architecture docs, or add an ADR, only if the design changed. Record any
  follow-ups for F2, F3, or F4 in the progress log.
