# UX9: Automatic commit-date/hash version in development and containers

- Status: Ready
- Wave: 1; dependencies: baseline `05326ce`; migration: no
- Branch/worktree: `task/ux9` / `..\pandalibrary-ux9`

## Read first and ownership

Read [the plan](../plans/sidebar-dashboard-plan.md), command `main.version`,
Taskfile, Dockerfile/.dockerignore, CI/release workflows, Vite proxy,
container/release check scripts, and app construction.
Own new `internal/buildinfo/**`, `internal/httpapi/version*.go`, command
version wiring/tests, build scripts/Taskfile/Dockerfile/.dockerignore,
CI/release/container-check wiring, a localized app mount addition,
`web/src/lib/buildinfo/**`, and `ux9.*` messages.
Do not edit root layout/sidebar/nav, feature pages, or local ignored launchers.
UX10 wires your standalone component into UX1's footer.

## Implement

1. One server-side source of version truth: display
   `YYYYMMDD-HHmmss+<12-character-hash>` using commit committer time in UTC,
   not wall-clock build time. Expose full commit hash, RFC3339 commit_date,
   dirty state, and optional release tag as separate safe metadata. Existing
   `pandalibrary version` must include date/hash, not just `dev` or a tag.
2. Add public read-only `GET /api/v1/version` returning
   `{version,commit,commit_date,dirty,release}` (release nullable). Include
   no paths, environment, command output, usernames or credentials.
   Use an isolated Mount and existing HTTP/logger conventions.
3. Ensure documented `task build`, ordinary `go build`, `go run` development,
   and frontend Vite + proxied backend expose correct current provenance.
   Go VCS build info can cover ordinary builds, but explicitly test `go run`
   rather than assuming it embeds the same metadata. A narrowly scoped dev
   resolver may run Git in a discovered source checkout when no stamped/VCS
   data exists; built release/container runtime must never require Git.
   Use one normalization/validation policy, no duplicated version formulas.
4. Because `.git` is excluded from Docker context, supply provenance from the
   host/build environment automatically through a tracked portable build
   wrapper (for example `scripts/build-container.mjs`) and Docker build args.
   Resolve date/hash from the checked-out commit, pass them into the Go binary,
   and wire CI/release/container-check scripts to that same path. A user must
   not manually type a date/hash for normal documented container builds.
   Raw Docker/archive builds without Git must accept explicit validated
   provenance or fail clearly; never produce a success-shaped fake version.
5. Preserve multi-stage scratch/non-root/healthcheck/CGO-free image behavior,
   release tags and existing size checks. Git history need not be copied into
   the image; no Git/Node subprocess may be required after container startup.
   Handle shallow checkouts, timezone changes, spaces, and invalid metadata.
   If metadata truly cannot be resolved, report unavailable explicitly in dev;
   provenance-required release/image builds must fail.
6. Export `web/src/lib/buildinfo/BuildVersion.svelte`, which fetches the same
   endpoint and renders a compact sidebar footer with readable version and
   accessible full commit/date detail. Handle loading/failure/offline explicitly;
   do not substitute package.json's frontend version or a startup timestamp.
   Do not cache one user's private data; version itself is public.

## Acceptance and validation

Compare exact date/hash to `git show -s --format=%cI HEAD` and
`git rev-parse HEAD`, including UTC conversion and dirty labeling.
Test CLI/API/component formatting, invalid/missing stamps, injected metadata
vs VCS precedence, ordinary build AND go-run dev, Vite proxy, shallow checkout
or equivalent fixture, and container runtime with no `.git`/Git installed.
The same commit must display the same base version in dev and image.
Run relevant Go/frontend checks and existing container-check; verify readiness,
CLI and HTTP metadata from the actual image. Record exact commands/results
and component/API/build invocation contracts for UX10 in your hand-off.
