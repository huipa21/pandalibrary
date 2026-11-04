# UX9: Automatic commit-date/hash version in development and containers

- Status: Done
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

## UX10 hand-off

- Import `BuildVersion` from `#lib/buildinfo/BuildVersion.svelte` into UX1's
  bottom sidebar footer. UX9 intentionally does not alter the root layout or
  navigation. The component requests the public endpoint without credentials or
  caching, displays the version in a keyboard-accessible disclosure with full
  commit/date, dirty state, and optional release, and handles loading, offline,
  failure, retry, and reconnect. English and Chinese `ux9.*` messages are present.
- `GET /api/v1/version` is public and read-only with `Cache-Control: no-store`.
  Its exact JSON fields are `version`, `commit`, `commit_date`, `dirty`, and
  nullable `release`. `commit_date` is RFC3339 UTC; `version` is the UTC commit
  timestamp plus 12 hash characters and optional `-dirty`. If provenance is
  unavailable, the endpoint responds with HTTP 503 and the CLI exits with an
  explicit error. The server remains healthy and logs the unavailable state.
- `pandalibrary version` prints the same version; a release label is appended as
  ` (release <tag>)` rather than replacing commit provenance. Validated explicit
  build stamps take precedence over Go VCS metadata. With neither, only a
  `go run` executable may resolve Git in the matching source checkout; invalid
  stamps never fall back. The resolved metadata describes the build or the
  `go run` process at startup, not changes made afterward.
- `node scripts/build-container.mjs --tag pandalibrary:local` obtains the stamp
  automatically. Add `--release <tag>` only for a local tag pointing at `HEAD`;
  use `CONTAINER_ENGINE=podman` for Podman. Release binaries use
  `node scripts/build-binary.mjs --output <path> --release <tag>` and honor
  `GOOS`/`GOARCH`. Raw Git-free image contexts require explicit `COMMIT`,
  `COMMIT_DATE`, and `DIRTY` build arguments, with optional `RELEASE`; Go's
  shared validator rejects missing or invalid values. Scratch runtime needs
  neither Git nor Node.js.

### Verification recorded on 2026-11-04

- `task lint` and `task test`: passed, including the public mount, validation,
  stamp/VCS precedence, shallow checkout, dirty state, and repeated fresh/cached
  `go run` tests. `task build` also passed in an isolated checkout so the
  pre-existing local executable was not overwritten.
- `pnpm --dir web check`, `pnpm --dir web test` (167 tests), and
  `pnpm --dir web build`: passed. `node --test scripts/build.test.mjs` passed
  the portable wrapper/shallow-checkout tests. An initial frontend run alongside
  Go lint hit the existing reader test's five-second timeout; the full suite
  passed when rerun without competing build load.
- `node web/scripts/build-version-check.mjs`: passed in Chromium for loading,
  the accessible disclosure, offline, failure, retry, and reconnect.
- In an isolated checkout with a local `ux9-fixture` tag,
  `node scripts/build-binary.mjs --output dist/ux9-release.exe --release ux9-fixture`
  produced the expected tagged CLI version. The same wrapper cross-built a Linux
  ARM64 binary with `GOOS=linux` and `GOARCH=arm64`. Both the tagged build and
  repeated `go run` also passed from a checkout path containing spaces.
- With an isolated data directory, `go run ./cmd/pandalibrary version`,
  `go run ./cmd/pandalibrary serve`, and the Vite `/api/v1/version` proxy matched
  `git show -s --format=%cI HEAD` and `git rev-parse HEAD`. The development page
  returned HTTP 200. At that checkout, `2026-11-04T20:49:36+08:00` and commit
  `210fa5946fefa8b8bddc0ba093c12658394df122` produced
  `20261104-124936+210fa5946fef-dirty` and `2026-11-04T12:49:36Z`.
- `$env:CONTAINER_ENGINE = 'podman'; node web/scripts/container-check.mjs`:
  passed against the actual non-root scratch image, with the same CLI/API
  provenance, health, setup, migrations, unhealthy detection, and SIGTERM
  shutdown. Its compressed image archive was 11.4 MiB.
- With the isolated `ux9-fixture` tag and `RELEASE_VERSION=ux9-fixture`, the
  same container check passed and verified the separate release tag in both the
  CLI and HTTP response; the compressed image was also 11.4 MiB.
- `podman build --format docker --target build .` with no provenance arguments
  failed as required with an explicit `build provenance unavailable` error.
