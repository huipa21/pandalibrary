# F3: Web scaffold

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § F3
- Depends on (merged): F1
- Can run in parallel with: F2, X1
- Branch / worktree: `task/f3` in `..\pandalibrary-f3`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§1–3, 12, 14–15
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md)
- [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5
- [progress/README.md](../progress/README.md)
- The merged F1 CI workflow, README commands, Go module, and Taskfile

## Goal

Create the minimal SvelteKit SPA foundation that later tasks can extend independently.
It must build as static assets with a deep-link fallback, expose a typed API client and
navigation foundation, and be embeddable by the Go binary without implementing product
screens or API behavior.

## Scope

**Owns (create/modify freely):**
- `web/**` (scaffold and shared foundation only; leave future feature routes as stubs or
  absent)
- The web CI job in `.github/workflows/ci.yml`
- `Taskfile.yml` web tasks, if needed to expose the standard checks

**Shared files (append-only, see plan §4):**
- `.github/workflows/ci.yml` — add a web job without changing or removing the Go job
- `Taskfile.yml` — add web tasks without changing existing Go task behavior

**Must not touch:**
- Go database, server, or extraction implementation
- `internal/db/migrations/` or `sqlc.yaml`
- Application feature routes or screens owned by later web tasks
- F1's Go CI job behavior

## Requirements

1. Scaffold with SvelteKit, Svelte 5, TypeScript, Vite, and `adapter-static`. Configure a
   client-rendered SPA (`ssr = false`) with `fallback: 'index.html'`; the build output
   must be `web/build`.
2. Configure the Vite development server to proxy `/api`, `/opds`, and `/kosync` to the
   local Go server on port 8080. Keep the proxy target overridable through normal Vite
   configuration/environment rather than hard-coding it throughout the app.
3. Set up Tailwind CSS v4 and shadcn-svelte using the supported SvelteKit integration.
   Establish only the base app shell and a minimal placeholder page; do not implement
   login, library, reader, or admin UI.
4. Configure paraglide-js for English and Chinese with `web/messages/en.json` and
   `web/messages/zh.json`. Include only scaffold-level strings and keep locale keys
   structured for later feature areas.
5. Add a typed `fetch` API client foundation that supports a configurable base path,
   typed request/response use, and explicit handling of `application/problem+json`
   errors. Do not silently convert non-2xx responses into success values.
6. Add a small typed `nav.ts` registry foundation without feature-specific navigation
   entries. Add starter Vitest configuration and a representative test for the shared
   API error handling or other scaffold behavior.
7. Add `web/embed.go` with package `webui` and `//go:embed all:build`, so Go can embed
   the generated output. Verify the embed package compiles after a frontend build and
   that the fallback file is included.
8. Add Playwright configuration for later end-to-end tasks without introducing
   application-level browser tests in this scaffold. Keep browser installation and
   browser-run steps out of the default `pnpm test`.
9. Add a web CI job that installs the pinned Node and pnpm versions, uses the lockfile
   in frozen mode, and runs `pnpm check`, `pnpm test`, and `pnpm build`. Preserve the F1
   Go job and ensure independent jobs do not depend on generated/uncommitted artifacts.
10. Document the web scaffold's local commands and prerequisites in the root README
    only if F1's documentation does not already cover them. Keep dependency versions
    pinned through the project's package manager and do not add unneeded runtime
    dependencies.

## Out of scope

- Authentication, setup, profile, library, book, reader, notes, stats, or admin UI
- Service worker/offline behavior, metadata merge behavior, or API DTO generation
- Go server handlers or API implementation
- Docker or release packaging

## Acceptance criteria

- [x] `pnpm check`, `pnpm test`, and `pnpm build` pass from `web/`.
- [x] `web/build/index.html` exists and the output can be embedded by `web/embed.go`.
- [x] The SPA supports deep-link fallback and the dev proxy paths are configured.
- [x] The typed API client reports problem+json and other HTTP failures explicitly.
- [x] CI retains its Go job and runs the web check, test, and build commands.
- [x] No product feature routes or Go implementation files are added or changed.

## Validation commands

```powershell
pnpm -C web install --frozen-lockfile
pnpm -C web check
pnpm -C web test
pnpm -C web build
go test ./web
```

## Hand-off

- Update this prompt's status and F3's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Preserve the shared-file append-only rules when combining the CI and Taskfile changes.
- Note the API client and navigation conventions for later web tasks; update architecture
  docs or add an ADR only if the accepted design changes.
