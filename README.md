# PandaLibrary

Self-hosted ebook library: a single Go binary with an embedded SvelteKit PWA, SQLite,
OPDS 1.2, KOReader sync, and EPUB/MOBI/AZW3/FB2/CBZ/PDF readers in the browser.

Status: the Go foundation is in place and the web scaffold is implemented; product features
have not started yet. See
[docs/progress](docs/progress/README.md).

- [docs/](docs/README.md): architecture, decisions (ADRs), plans, prompts, progress
- [internal/db/migrations/](internal/db/migrations/): the database schema (goose migrations,
  applied automatically on startup)

## Go development

Install Go 1.27, [Task](https://taskfile.dev/), [staticcheck](https://staticcheck.dev/), and
[sqlc](https://sqlc.dev/) v1.31.1. CI uses these pinned tool versions:

```sh
go install github.com/go-task/task/v3/cmd/task@v3.54.0
go install honnef.co/go/tools/cmd/staticcheck@v0.8.2
go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1
```

Ensure the directory from `go env GOBIN`, or the `bin` directory under the first
`go env GOPATH` entry when `GOBIN` is unset, is on your `PATH`. From the repository root:

```sh
task build
task lint
task test
```

The build produces `pandalibrary` (`pandalibrary.exe` on Windows) with CGO disabled.
The default `serve` command, `healthcheck`, `user create`, and `user reset-password` are
stubs: each reports that it is not implemented and exits unsuccessfully.

### Database

`task sqlc` generates the query package, and `task sqlc:check` checks that generated output
is current. The migration operator commands are `task migrate:status`, `task migrate:up`,
and `task migrate:down-to VERSION=0` (development only). Set `PANDA_DATA_DIR` to choose the
directory containing `pandalibrary.db`; it defaults to `/data`. Migrations apply
automatically by default. `PANDA_AUTO_MIGRATE=false` disables startup upgrades, and
`PANDA_MIGRATE_BACKUP=false` disables pre-upgrade backups.

## Web development

Install Node.js 24.15.0 and pnpm 11.2.2. From the repository root:

```powershell
pnpm --dir web install --frozen-lockfile
pnpm --dir web dev
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
```

The development server proxies `/api`, `/opds`, and `/kosync` to
`http://127.0.0.1:8080`. Set `VITE_API_PROXY_TARGET` to override the backend URL.
Playwright is configured for later end-to-end tasks; browser installation and browser tests
are intentionally separate from `pnpm test`.

The Go `webui` package embeds `web/build`. On a fresh checkout, build the web app before
running Go build, lint, or test tasks; CI builds the assets independently in its Go job.
