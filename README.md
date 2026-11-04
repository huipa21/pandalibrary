# PandaLibrary

PandaLibrary is a self-hosted ebook library: a single Go server with an embedded web
application, SQLite storage, background imports, a browser reader/PWA, OPDS 1.2, and
KOReader progress sync. Supported book formats are EPUB, PDF, MOBI, AZW3, FB2, FBZ, and
CBZ; reader support depends on format and browser.

## Run with a container

Build the image from a release tag or source checkout:

```sh
docker build --build-arg VERSION=v1.0.0 -t pandalibrary:v1.0.0 .
docker volume create pandalibrary-data
docker run -d --name pandalibrary --restart unless-stopped \
  -p 8080:8080 -v pandalibrary-data:/data \
  -e PANDA_BASE_URL=https://books.example.org \
  pandalibrary:v1.0.0
```

The image is based on `scratch`, runs as UID/GID `65532:65532`, keeps all persistent
state under `/data`, and includes a binary `/healthz` healthcheck. The release workflow is
configured to attach Linux amd64 and arm64 binaries to GitHub Releases; the project does
not publish a container image. Build the image locally or publish it through your own
registry.

On the first start, open `https://books.example.org/setup` (or `http://localhost:8080/setup`
for local use) and enter the one-time setup token from the server logs to create the first
administrator. Treat this token and server logs as credentials; do not share unredacted
logs. To create or reset an account from a host binary instead, use the interactive CLI:

```sh
./pandalibrary user create --username admin --admin
./pandalibrary user reset-password --username admin
```

For container CLI operations, mount the same data volume and override the entrypoint:

```sh
docker run --rm -it -v pandalibrary-data:/data --entrypoint /pandalibrary \
  pandalibrary:v1.0.0 user create --username admin --admin
```

## Configuration and deployment

The server listens on `:8080` by default. Flags override the corresponding environment
variables.

| Environment variable | Default | Purpose |
|---|---|---|
| `PANDA_DATA_DIR` | `/data` | Database, books, covers, drop folder, temporary files, backups |
| `PANDA_LISTEN` | `:8080` | HTTP listen address |
| `PANDA_BASE_URL` | unset | Public origin; enables secure cookies on HTTPS and validates origins |
| `PANDA_DROP_DIR` | `<data-dir>/drop` | Watched import folder |
| `PANDA_DROP_POLL` | `0` | Optional polling fallback for network mounts; use a duration of at least `1s` |
| `PANDA_TRUSTED_PROXIES` | unset | Comma-separated CIDRs allowed to set forwarded headers |
| `PANDA_MAX_UPLOAD_MB` | `1024` | Maximum request size in MiB |
| `PANDA_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `PANDA_AUTO_MIGRATE` | `true` | Apply pending migrations during startup |
| `PANDA_MIGRATE_BACKUP` | `true` | Create a database backup before a migration |

Place the service behind a reverse proxy that terminates TLS and forwards the original
host/protocol safely. Set `PANDA_BASE_URL` to the externally visible HTTPS origin and set
`PANDA_TRUSTED_PROXIES` only to proxy CIDRs that sanitize forwarded headers. Do not expose
the application or its first-run setup to the public internet without TLS and an
administrator setup plan.

Persist `/data` across container replacement. The application stores the SQLite database,
content-addressed book files and covers, import drop folder, and backups there. The
automatic maintenance job retains seven verified database backups; it does not replace an
off-site backup of both the database and book/cover files.

To restore, stop the server, restore the database and matching `files/` and `covers/`
directories from the same backup point, then start with the matching or a newer binary.
Never start an older binary against a database already upgraded by a newer release. A
pre-migration backup is also retained in `/data/backups/`; restoring that backup with the
previous release is the rollback path.

## Using the library

- **Import:** Administrators can upload books in the Admin → Imports page. Files copied
  into `PANDA_DROP_DIR` are also imported after they remain stable for three seconds.
  Subdirectories named for a library slug route imports to that library; root-level drops
  require a configured default library. Import history and failures are visible in Admin.
- **Read and offline:** Open a book from the catalog to use the browser reader. Install
  the PWA from a supported browser and explicitly download books for offline reading.
  Progress changes are queued offline and synced after reconnect; storage can be managed
  from the offline page/settings.
- **OPDS:** Create an `opds` app password in Settings and configure an OPDS client with
  the catalog URL `https://books.example.org/opds` and the PandaLibrary username plus
  that app password. OPDS uses HTTP Basic authentication; use HTTPS.
- **KOReader:** Create a `kosync` app password and configure KOReader's Progress Sync
  plugin with the custom server `https://books.example.org/kosync`, your username, and the
  app password **without its display hyphens**. Do not use the web-login password or an
  OPDS app password.
- **Notes and shelves:** Notes, highlights, reading progress, and shelves are available
  from the web application. Notes can be exported as Markdown or ZIP from Notes.

## Upgrades and health

Each server start applies pending schema migrations automatically by default, taking a
pre-migration backup first. A database newer than the running binary is rejected. To
disable automatic migration, set `PANDA_AUTO_MIGRATE=false` and run the documented
`pandalibrary migrate up` command before startup. The container healthcheck invokes
`pandalibrary healthcheck`, which probes the local `/healthz` endpoint and returns
non-zero when the service is unavailable or not ready. Check readiness with:

```sh
docker inspect --format '{{.State.Health.Status}}' pandalibrary
curl --fail https://books.example.org/healthz
```

The release upgrade check seeds a database with an earlier release binary when that
release has a Linux amd64 asset. Before the first release exists, it generates a v1-schema
baseline with fixed test user/library data; later releases automatically use the previous
published binary.

Release binaries include their release version (`pandalibrary version`). Releases are
published only when a GitHub Release is published; the workflow validates the browser
suite, upgrade baseline, and scratch image before attaching Linux amd64/arm64 binaries.

## Known limitations

- Plain FB2 with a UTF-8 BOM or Windows-1251 encoding can fail importer format detection;
  UTF-8 FB2 without a BOM and FBZ are supported.
- Real KOReader device chapter-XPointer behavior has not been validated. Reflowable books
  retain the last device XPointer while syncing newer web percentage/time; PDF and CBZ
  positions use exact pages.
- Browser format support and offline storage vary by device/browser. DRM-protected books
  are not supported.

## Development

Development requires Go 1.27, Node.js 24.15.0, and pnpm 11.2.2.
Root-level `dev.cmd` and `dev.ps1` are optional, local-only launchers and are
Git-ignored; they are not included in a fresh checkout. Use the commands below
for the supported development workflow. On first use, enter the `setup_token`
printed by the backend to create an administrator; keep the token private.

Also install Task and staticcheck for the checks below:

```sh
go install github.com/go-task/task/v3/cmd/task@v3.54.0
go install honnef.co/go/tools/cmd/staticcheck@v0.8.2
go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1
pnpm --dir web install --frozen-lockfile
pnpm --dir web build
task build
task lint
task test
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
```

Run the app locally with `./pandalibrary serve --data-dir ./data --listen 127.0.0.1:8080`;
on Windows use `.\pandalibrary.exe`. The development web server proxies `/api`, `/opds`,
and `/kosync` to `http://127.0.0.1:8080`. `VITE_API_PROXY_TARGET` overrides that backend.
Run `pnpm --dir web test:e2e` for the browser suite; CI builds the Go binary and points the
same suite at its real server and embedded SPA.

Run the release checks locally after building the web assets and binary (PowerShell):

```powershell
$env:PANDA_E2E_BINARY = (Resolve-Path .\pandalibrary.exe).Path
pnpm --dir web test:e2e
$env:PANDA_CANDIDATE_BINARY = $env:PANDA_E2E_BINARY
# Optional: set PANDA_PREVIOUS_BINARY to a downloaded previous-release executable.
node web\scripts\upgrade-check.mjs
node web\scripts\container-check.mjs
```

Real-server tests allocate an unused loopback port and isolated temporary data, then stop
the server and remove that data on teardown. Redacted server diagnostics are saved under
`web/test-results/`. `PANDA_E2E_PORT` can override the allocated port. Container checks use
Docker by default; set `CONTAINER_ENGINE=podman` for Podman (the checker explicitly builds
Docker-format metadata to preserve the healthcheck).

SQL migrations are under [internal/db/migrations](internal/db/migrations/). Useful
operator commands are `pandalibrary migrate status`, `pandalibrary migrate up`, and
`pandalibrary migrate down-to <version>` (development only). See
[docs](docs/README.md) for architecture, decisions, plans, and implementation status.
