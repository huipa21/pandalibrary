# PandaLibrary

Self-hosted ebook library: a single Go binary with an embedded SvelteKit PWA, SQLite,
OPDS 1.2, KOReader sync, and EPUB/MOBI/AZW3/FB2/CBZ/PDF readers in the browser.

Status: the Go foundation is in place and the web scaffold is implemented; product features
have not started yet. See
[docs/progress](docs/progress/README.md).

- [docs/](docs/README.md): architecture, decisions (ADRs), plans, prompts, progress
- [internal/db/migrations/](internal/db/migrations/): the database schema (goose migrations,
  applied automatically on startup)

## Database development

Prerequisites: Go 1.27 or newer, [Task](https://taskfile.dev/), [staticcheck](https://staticcheck.dev/),
and [sqlc](https://sqlc.dev/) v1.31.1. Install staticcheck and sqlc with:

```powershell
go install honnef.co/go/tools/cmd/staticcheck@latest
go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1
```

Run `task build`, `task lint`, and `task test` from the repository root. `task sqlc`
generates the query package, and `task sqlc:check` checks that generated output is current.
The migration operator commands are `task migrate:status`, `task migrate:up`, and
`task migrate:down-to VERSION=0` (development only). Set `PANDA_DATA_DIR` to choose the
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
