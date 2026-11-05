# PandaLibrary

PandaLibrary is a self-hosted ebook library: a single Go server with an embedded web
application, SQLite storage, background imports, a browser reader/PWA, OPDS 1.2, and
KOReader progress sync. Supported book formats are EPUB, PDF, MOBI, AZW3, FB2, FBZ, and
CBZ; reader support depends on format and browser.

## Run with a container

Build the image from a Git source checkout (Node.js and Docker are required):

```sh
node scripts/build-container.mjs --tag pandalibrary:local
docker volume create pandalibrary-data
docker run -d --name pandalibrary --restart unless-stopped \
  -p 8080:8080 -v pandalibrary-data:/data \
  -e PANDA_BASE_URL=https://books.example.org \
  pandalibrary:local
```

The wrapper automatically passes the checked-out commit, its committer date, and
the tracked/non-ignored untracked dirty state to the image build. Set `CONTAINER_ENGINE=podman`
to use Podman. For a tagged release, add `--release v1.0.0`; that local Git tag
must point to `HEAD`. The optional release label must begin with an ASCII letter
or digit and contain at most 128 ASCII letters, digits, `.`, `_`, `+`, `/`, or `-`.

For a source archive without Git, supply trustworthy provenance explicitly.
The commit must be a full 40- or 64-character hexadecimal object ID, the date
must be the commit's RFC3339 committer timestamp with second precision, and
the dirty state must be `true` or `false`:

```sh
docker build --build-arg COMMIT="$PANDA_COMMIT" \
  --build-arg COMMIT_DATE="$PANDA_COMMIT_DATE" --build-arg DIRTY="$PANDA_DIRTY" \
  -t pandalibrary:local .
```

An optional `--build-arg RELEASE="$PANDA_RELEASE"` adds the release label.
Missing or invalid provenance fails the image build; it never creates a fake
version. The image does not include Git or Node.js.

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

Administrators can also manage accounts through the session-authenticated
[`/api/v1/admin/users` API](docs/prompts/UX7-admin-users-api.md#ux8-api-hand-off).
The **Admin -> User accounts** panel supports paged accounts, create/edit,
disable/re-enable, deletion, password reset and credential revocation. Grants
and hide lists select accounts by username/display name rather than guessed IDs.
Password resets (including the CLI) and account disabling revoke all browser
sessions and OPDS/KOReader app passwords. Devices must be issued new app passwords.
Self-service administrator reset/revocation also signs the administrator out.

For container CLI operations, mount the same data volume and override the entrypoint:

```sh
docker run --rm -it -v pandalibrary-data:/data --entrypoint /pandalibrary \
  pandalibrary:local user create --username admin --admin
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
- **Dashboard and bookmarks:** The signed-in home page has configurable reading
  feeds and shelf sections, including an intentionally empty layout. The sidebar
  contains All Books, Bookmarks, Notes, live shelf counts and the build version.
  Its plus button creates manual or rule-based automatic shelves. Reader bookmarks
  save exact PDF/CFI positions; Bookmarks opens, renames and deletes them across
  books. Changes survive offline reload and synchronize after reconnect, isolated
  by account. A bookmark whose original file is unavailable is not opened at a
  guessed position.
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
baseline with fixed user/library, shelf membership, annotation, note, reader-setting
and book-file fixtures; later releases automatically use the previous
published binary.

`pandalibrary version` reports `YYYYMMDD-HHmmss+<12-character-hash>`, using
the commit's committer timestamp in UTC; a modified checkout adds `-dirty`.
A release tag is shown separately when supplied. Public `GET /api/v1/version`
returns the same version plus the full commit hash, UTC RFC3339 `commit_date`,
boolean `dirty`, and nullable `release`; responses are not cached. If provenance
is unavailable, the CLI reports an error and the endpoint returns HTTP 503
rather than an invented version. Releases are published only when a GitHub
Release is published; the workflow validates the browser suite, upgrade baseline,
and scratch image before attaching Linux amd64/arm64 binaries.

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
on Windows use `.\pandalibrary.exe`. After building the web assets,
`go build ./cmd/pandalibrary`, `task build`, and `go run ./cmd/pandalibrary serve`
also report the checkout's commit provenance automatically. Go builds use embedded
VCS metadata; an unstamped `go run` resolves Git only in its source checkout.
Installed and container binaries never require Git at runtime. Start the frontend
with `pnpm --dir web dev`; its development server proxies `/api`, `/opds`, and
`/kosync` to `http://127.0.0.1:8080`. `VITE_API_PROXY_TARGET` overrides that backend.
For explicitly stamped release binaries, use
`node scripts/build-binary.mjs --output bin/pandalibrary --release v1.0.0`
from the tagged checkout; `GOOS` and `GOARCH` can select a target platform.
Run `pnpm --dir web test:e2e` for the browser suite; CI builds the Go binary and points the
same suite at its real server and embedded SPA.

Run the release checks locally after building the web assets and binary (PowerShell):

```powershell
$env:PANDA_E2E_BINARY = (Resolve-Path .\pandalibrary.exe).Path
pnpm --dir web test:e2e
node --test scripts\build.test.mjs
node web\scripts\build-version-check.mjs
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
