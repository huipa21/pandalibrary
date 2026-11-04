# Q1: Release and end-to-end

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § Step 11
- Depends on (merged): F1–F4, A1, C1, R1, W1–W7, X1–X3, I1, S1, SH1, K1, M1, J1, ST1, E1, O1
- Can run in parallel with: —
- Branch / worktree: `task/q1` in `..\pandalibrary-q1`
- Migration: no

## Read first

- [docs/README.md](../README.md), [progress/README.md](../progress/README.md), and
  [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5
- [architecture/system.md](../architecture/system.md) §§4–6, 14–16 and
  [architecture/migrations.md](../architecture/migrations.md) §§2, 5
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0003](../decisions/0003-auto-applied-migrations.md), and
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- The root [README.md](../../README.md), `.github/workflows/ci.yml`, `Taskfile.yml`,
  `web/playwright.config.ts`, and every existing `*.e2e.ts` test
- The merged application/configuration, setup, healthcheck, importer, and migration code
  that the deployment and E2E tests will exercise

## Goal

Make PandaLibrary ready to build, run, upgrade, and verify as a release: ship a small
non-root container with a working healthcheck, run the complete browser suite against the
real server in CI, prove automatic database upgrades preserve existing data, and give
operators a concise user and deployment guide in the root README.

## Scope

**Owns (create/modify freely):**
- `Dockerfile`
- `.github/workflows/release.yml` and the minimum necessary CI workflow changes
- The full Playwright suite and its server/test harness under `web/`
- The user and operator guide in the root `README.md`

**Shared files (append-only, see plan §4):**
- `.github/workflows/ci.yml` — add release-gate checks without removing existing jobs
- `web/package.json` / `web/pnpm-lock.yaml` — only if the E2E runner requires a justified
  dependency or script change
- [progress/README.md](../progress/README.md) — edit only the Q1 row and append a Q1 log

**Must not touch:**
- `internal/db/migrations/`, service/API contracts, or feature behavior except for a
  narrowly scoped testability fix required to run the real-server suite
- Existing CI checks that are unrelated to the release gate
- Credentials, signing keys, or deployment secrets in source, image layers, or logs

## Requirements

1. Add a multi-stage Docker build following
   [system.md §14](../architecture/system.md). Build the web assets and static Go binary
   from the repository's pinned toolchain; use a `scratch` final image containing only the
   binary and required CA certificates. Run as UID/GID `65532:65532`, provide writable
   persistent `/data`, expose port 8080, and use the binary's `healthcheck` subcommand
   rather than adding a shell or curl to the image. Preserve the supported environment
   variables and startup migration behavior.
2. Verify the built image's actual compressed size against the plan's approximately
   25–35 MB target. Run the container with a temporary persistent data directory and
   confirm first-start migrations complete, the service becomes healthy, `/setup` is
   reachable, and SIGTERM shuts it down cleanly. The healthcheck must fail when the
   service is unavailable or unhealthy; do not rely only on a successful image build.
3. Make the full Playwright suite run in CI against the real compiled server and embedded
   SPA, not only Vite's static preview or mocked API responses. Start each run with an
   isolated temporary data directory and port, wait for readiness, capture useful server
   output on failure without leaking the setup token or other credentials, and always
   stop the process and clean up its temporary data.
4. Preserve and run the existing browser coverage. Ensure the integrated suite exercises
   the critical user journeys represented by the app: initial setup and login, catalog
   browse/search, admin upload/import, opening a book and saving progress/annotations,
   offline progress syncing after reconnect, notes/export, shelves, metadata editing,
   and admin workflows. Use deterministic fixtures and stub optional third-party
   metadata providers; CI must not depend on live provider services or a real KOReader
   device. Do not duplicate backend protocol tests that are already covered by Go tests.
5. Add an automated upgrade check that starts a database created by the previous released
   version with the candidate binary, verifies startup migrations apply automatically,
   confirms the server becomes healthy, and checks representative pre-existing data is
   still usable. Reuse an actual prior release artifact when one exists. For the first
   release, provide a deterministic, checked-in or generated prior-schema fixture and
   document how the test switches to the previous release artifact once available; never
   silently omit the upgrade check.
6. Add a release workflow that builds and validates release artifacts only for the
   repository's intended release trigger. Follow the existing workflow conventions, use
   least-privilege permissions, and do not publish from pull requests. If publishing a
   container or binaries, use the repository's supported GitHub token permissions and
   avoid requiring undocumented secrets. Include version metadata in the binary/image
   and verify the produced artifacts with the same container and upgrade checks used in
   CI.
7. Update the root README into a practical user/operator guide while retaining accurate
   development instructions. Cover installation or container startup, persistent data
   and backups, first-admin setup, configuration and reverse-proxy/TLS expectations,
   importing books, browser reading/offline behavior, OPDS and KOReader setup, upgrades,
   healthchecks, and recovery/known limitations. Keep commands and environment-variable
   defaults consistent with the implementation and architecture docs. Do not claim
   unresolved format or real-device behavior is validated.
8. Keep the workflow reproducible and bounded: pin tool versions consistently with the
   project, avoid network-dependent tests except for fetching declared build dependencies,
   and ensure failure output identifies the failing validation step without printing
   secrets.

## Out of scope

- New product features, schema changes, or changes to API semantics
- Fixing unrelated extractor or reader limitations; accurately record any remaining
  release caveats instead
- Operating a production deployment or configuring user-specific domains/secrets

## Acceptance criteria

- [ ] A clean Docker build produces a scratch-based image in the planned size range,
  running non-root with persistent `/data` and a passing binary healthcheck.
- [ ] Container startup, first-run setup reachability, automatic migration, graceful
  shutdown, and unhealthy-service detection are verified.
- [ ] The complete Playwright suite passes against the built binary and embedded SPA in
  CI, with isolated state and no live provider/device dependency.
- [ ] The upgrade test starts a prior-version database with the candidate binary,
  verifies automatic migration and health, and confirms existing data remains usable.
- [ ] CI retains its existing Go and web checks; the release workflow runs only on the
  intended release trigger and does not publish on pull requests.
- [ ] The root README accurately documents setup, core use, configuration, deployment,
  backup/recovery, and known limitations.
- [ ] `task build`, `task lint`, `task test`, `pnpm --dir web check`,
  `pnpm --dir web test`, `pnpm --dir web build`, the full E2E suite, Docker build,
  container healthcheck, and upgrade test pass.

## Validation commands

```powershell
task build
task lint
task test
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:e2e
docker build -t pandalibrary:q1 .
```

Also run the documented container-health and migration-upgrade checks using disposable
data directories, and report the resulting image size and tested upgrade source.

## Hand-off

- Update this prompt's status and Q1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record the container size, release trigger/artifacts, E2E environment, and upgrade-test
  baseline. Update architecture docs or add an ADR only if the accepted deployment design
  changes.

## Implementation hand-off

- CI and the published-release workflow build a scratch image, report its gzipped image
  archive size, and test non-root `/data`, first-run migration/setup, healthcheck failure,
  and clean SIGTERM shutdown. All checks pass locally with Podman using Docker image
  metadata (OCI metadata drops healthchecks). The measured archive is 11.3 MiB, below the
  35 MiB ceiling; the uncompressed image is about 28.5 MB.
- Playwright runs all existing UI tests against the compiled server and embedded SPA,
  plus a real setup/import/search/read/progress/annotation/export/shelf journey. Reader
  CSP interception preserves the server's per-response nonce. Playwright global setup
  owns the server process directly, allocates a loopback port and isolated data, and
  returns bounded teardown that closes the process before deleting its data/token.
  Startup-failure cleanup and successful-run cleanup are verified on Windows.
  Redacted server diagnostics are retained in `web/test-results/` and uploaded on CI
  failure. Static-preview mode keeps its 38 passing tests and skips the live journey.
- The upgrade check uses the latest prior published Linux amd64 binary when available.
  Both CI and release workflows fetch that binary and make it executable. Until one
  exists, Node's built-in SQLite creates the initial v1 schema directly from the immutable
  migration, with deterministic administrator/library data and migration metadata;
  candidate startup must preserve login/library access and leave migrations up to date.
  Both branches pass locally; the optional previous-binary branch was exercised with the
  same local build, not an actual prior published artifact.
- Go build/lint/test, web check/test/build, all 39 real-server Playwright tests, and the
  generated baseline upgrade check pass locally (161 frontend unit tests). GitHub
  workflows are configured but have not been executed remotely in this session.
- Releases trigger only on `release.published`, validate before attaching versioned
  Linux amd64/arm64 binaries, and require only the built-in GitHub token. The project does
  not publish a container image; operators build it from source.
