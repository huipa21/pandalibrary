# PandaLibrary

Self-hosted ebook library: a single Go binary with an embedded SvelteKit PWA, SQLite,
KOReader sync, and EPUB/MOBI/AZW3/FB2/CBZ/PDF readers in the browser. OPDS 1.2 is
planned.

Status: authentication, catalog, importing, search, shelves, browser reading and offline
sync, KOReader sync, metadata providers, and maintenance jobs are implemented. See
[docs/progress](docs/progress/README.md) for remaining work.

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
task web:build
task build
task lint
task test
```

The build produces `pandalibrary` (`pandalibrary.exe` on Windows) with CGO disabled.
Create users or reset a password through the CLI; passwords are entered interactively
without echo and are never accepted as command-line arguments:

```powershell
.\pandalibrary.exe user create --username admin --admin
.\pandalibrary.exe user reset-password --username admin
```

### Running the server

The default command is `serve`; its flags can also be used without the subcommand. For
example:

```powershell
.\pandalibrary.exe serve --data-dir .\data --listen 127.0.0.1:8080
.\pandalibrary.exe healthcheck --listen 127.0.0.1:8080
```

On Unix, use `./pandalibrary` instead. The healthcheck probes the local `/healthz`
endpoint and exits non-zero if it is unavailable or unhealthy. When `serve` uses a
non-default `--listen` flag, pass the same flag to `healthcheck` or set `PANDA_LISTEN`
for both commands. The server applies migrations before opening the listener. On first
run, it logs a one-time setup token; open `/setup` in the embedded SPA and enter that token
to create the initial administrator. The browser then uses cookie-backed login.

Server flags override their corresponding environment variables:

| Environment variable | Serve flag | Default |
|---|---|---|
| `PANDA_DATA_DIR` | `--data-dir` | `/data` |
| `PANDA_LISTEN` | `--listen` | `:8080` |
| `PANDA_DROP_DIR` | `--drop-dir` | `<data-dir>/drop` |
| `PANDA_DROP_POLL` | `--drop-poll` | `0` (disabled) |
| `PANDA_BASE_URL` | `--base-url` | unset |
| `PANDA_TRUSTED_PROXIES` | `--trusted-proxies` | unset |
| `PANDA_MAX_UPLOAD_MB` | `--max-upload-mb` | `1024` |
| `PANDA_LOG_LEVEL` | `--log-level` | `info` |

Trusted proxies are a comma-separated list of CIDRs; only configure proxies that sanitize
forwarded headers. The drop directory is created and watched at startup.
`PANDA_BASE_URL` supplies the trusted public origin for cookie-origin checks and enables
the `Secure` attribute on session cookies when it uses HTTPS. Use
`pandalibrary serve --help` for flag details.

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
Playwright browser installation and end-to-end tests are separate from `pnpm test`; run
the browser tests with `pnpm --dir web test:e2e`.

The Go `webui` package embeds `web/build`. On a fresh checkout, build the web app before
running Go build, lint, or test tasks; CI builds the assets independently in its Go job.

## KOReader progress sync (K1)

In Settings, create an app password with kind `kosync`. In KOReader's Progress Sync
plugin, set the custom server to `https://your-host/kosync`, log in with your PandaLibrary
username, and enter that app password **without its display hyphens** (preserve its case).
Do not use your web-login password or an OPDS app password; registration from KOReader is
disabled. Use HTTPS because the MD5 credential sent by KOReader is reusable.

Use KOReader's **Binary** document checksum and the unchanged imported file for web/device
sync. Unknown digests still sync between KOReader devices, but cannot update library
progress or reading sessions. Access restrictions apply to all library bridging.

PDF/CBZ web positions sync by exact page. Real-device chapter-XPointer validation has not
been performed, so reflowable books safely retain the last KOReader XPointer with the newer
web percentage/timestamp; jump manually to that percentage if needed. If no device
XPointer exists yet, no position is fabricated. KOReader-to-KOReader positions remain exact.

## Importing books (I1)

Administrators can send a multipart `library_id` and one `file` to
`POST /api/v1/uploads`, or one `file` to `POST /api/v1/books/{id}/files` to attach
another format. Both return `202` with a durable import job. Poll
`GET /api/v1/imports?limit=50` for job outcomes and duplicate book references.

Files placed in the configured drop directory are imported after their size and mtime
remain stable for three seconds. Root files require `server_settings.default_library_id`;
`drop/<library-slug>/` targets that library. Hidden files, symlinks, unknown folders,
and `.part`, `.crdownload`, and `.tmp` files are ignored. Successful sources are removed
after commit, duplicates move to `.duplicates/`, and failures move to `.failed/` with a
bounded error sidecar.

fsnotify and a startup scan are enabled by default. For network mounts with unreliable
notifications, set `PANDA_DROP_POLL=5s` or pass `--drop-poll 5s`. The value is `0` to
disable polling, or a Go duration of at least `1s`. Polling supplements notifications
and also provides a fallback when fsnotify cannot initialize.

EPUB, PDF, MOBI, AZW3, UTF-8 FB2 without a BOM, FBZ, and CBZ are registered. Plain FB2
with a UTF-8 BOM or Windows-1251 encoding remains blocked by the known sniffer issue;
FBZ extraction is unaffected. See [the I1 hand-off](docs/prompts/I1-importer.md) for
the API contract and restart-spool lifecycle used by maintenance and admin UI work.
