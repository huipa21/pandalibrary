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
`/api/v1/admin/users` API.
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
| `PANDA_DATA_DIR` | `/data` | Database, books, covers, annotation images, drop folder, temporary files, backups |
| `PANDA_LISTEN` | `:8080` | HTTP listen address |
| `PANDA_BASE_URL` | unset | Public origin; enables secure cookies on HTTPS and validates origins |
| `PANDA_DROP_DIR` | `<data-dir>/drop` | Watched import folder |
| `PANDA_BOOKHEAP_DIR` | `<data-dir>/bookheap` | Admin staging folder for unsorted books; must not overlap the drop folder or `files/`, `covers/`, `assets/`, `tmp/`, `backups/` |
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
content-addressed book files, covers and annotation images, import drop folder, Bookheap folder, and backups
there. The automatic maintenance job retains seven verified database backups; it does not
replace an off-site backup of both the database and book/cover/image files. Database backups
include the Bookheap index but not the files waiting in the Bookheap folder; back that
folder up separately if it holds books you have no other copy of. After a restore, run
**Scan** on the Bookheap page to re-index it.

To restore, stop the server, restore the database and matching `files/`, `covers/` and `assets/`
directories from the same backup point, then start with the matching or a newer binary.
Never start an older binary against a database already upgraded by a newer release. A
pre-migration backup is also retained in `/data/backups/`; restoring that backup with the
previous release is the rollback path.

In a container the default Bookheap folder (`PANDA_BOOKHEAP_DIR`) is inside the `/data`
volume, owned by UID/GID `65532:65532`. When mounting a separate folder, make it writable
by that user and keep it outside the drop folder and `files/`, `covers/`, `assets/`, `tmp/`,
`backups/`.

## Using the library

See the [user guide](docs/user/README.md) for what each part of PandaLibrary does:

- [Using PandaLibrary](docs/user/using-pandalibrary.md): dashboard, browsing, book pages,
  the reader, offline reading, bookmarks, notes, shelves, search and stats.
- [Reading apps and devices](docs/user/devices.md): OPDS apps and KOReader progress sync.
- [Administration](docs/user/administration.md): adding books, the Bookheap, accounts,
  libraries and access, metadata providers and maintenance.

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

On Windows, if Vite exits with `3221226505` or `-1073740791` (`0xC0000409`),
try updating to [Node.js 24 LTS](https://nodejs.org/en/download) 24.22.2 or a
newer 24.x release, then restart the terminal. The crash was reproduced with
Node.js 24.15.0 on one Windows system but not with 24.22.2; its underlying
cause is not confirmed. If a launcher stops both servers after the frontend
crashes, a browser shelves connection error can be a consequence.

To run without Vite while troubleshooting, first stop other servers using the
same data directory, then run in PowerShell:

```powershell
pnpm --dir web build
go run .\cmd\pandalibrary serve --data-dir .\data --listen 127.0.0.1:8080 --base-url http://127.0.0.1:8080
```

Open `http://127.0.0.1:8080`. Frontend edits require rebuilding and restarting
the server in this mode.

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

The [PDF engine](web/src/lib/reader/pdf.ts) exposes `viewState` and
`subscribeView`, plus `setLayout`, `setZoom`, `zoomBy`, `rotate`, and
`setCoverAlone`. Layouts are `single`, `single-continuous`, `split`, and
`split-continuous`. Zoom accepts `auto`, `page-actual`, `page-fit`, `page-width`,
or a scale from `0.1` to `5` (1 = 100%). PDF settings use `pdfLayout`,
`pdfZoom`, `pdfRotation`, and `pdfCoverAlone` in the existing format/book
settings. Consumers should unsubscribe on teardown and copy view changes
back to saved settings when offering gesture-driven zoom. Continuous layouts
keep page placeholders but render only nearby canvases. Highlight rectangles
remain normalized in the page's original orientation; rotation is applied
only when selecting or painting them.

### Annotation image assets

Session-authenticated `POST /api/v1/me/annotation-assets` accepts a raw PNG, JPEG
or WebP body (maximum 5 MiB; dimensions 1–8192 pixels). Writes require the same
origin protection as other session APIs. It returns
`{ "asset": { "sha256", "media_type", "size", "width", "height" } }` with `201`
for a new owner or `200` for a repeat upload. Validation failures expose problem
codes `asset_too_large` (413), `unsupported_media_type` (415), `invalid_image`
or `invalid_image_dimensions` (400).

`GET /api/v1/me/annotation-assets/{sha256}` serves only the current account's
images, with `private, no-store`, `nosniff` and a restrictive CSP. Identical images
share a file under `assets/<prefix>/<sha256>.<png|jpg|webp>` but have separate
ownership rows. The daily `annotation-assets-gc` job removes ownership older than
24 hours without a live page annotation; a blob is removed only after its last
owner is gone. Orphan sweep also recovers abandoned files and deleted-account
images. Both jobs can be run from **Admin -> Maintenance**.

For the insert-tool integration, [prepare-image.ts](web/src/lib/reader/assets/prepare-image.ts)
exports `prepareAnnotationImage(file: Blob)`, returning
`{ blob, width, height, media_type }` (at most 2048 pixels / 2 MiB).
[assets-api.ts](web/src/lib/reader/assets/assets-api.ts) exports
`uploadAnnotationAsset(prepared)` and typed, localized errors.
[asset-cache.ts](web/src/lib/reader/assets/asset-cache.ts) exports
`annotationAssetUrl(sha256, signal?)`, `revokeAssetUrls()` and `clearAssetCache()`.
URLs come from an account-keyed IndexedDB cache with a 200 MiB per-account LRU
budget. Uploads and uncached downloads require a connection; cached images work
offline. Revoke URLs when the reader is destroyed; sign-out also revokes them
and clears the cache. These helpers use the active offline viewer and the
existing Web Locks session guard.

### Release verification

Run the release checks locally after building the web assets and binary (PowerShell):

```powershell
$env:PANDA_E2E_BINARY = (Resolve-Path .\pandalibrary.exe).Path
pnpm --dir web test:e2e
node --test scripts\build.test.mjs
node web\scripts\build-version-check.mjs
$env:PANDA_CANDIDATE_BINARY = $env:PANDA_E2E_BINARY
# Optional: set PANDA_PREVIOUS_BINARY to a downloaded previous-release executable.
node web\scripts\upgrade-check.mjs
node web\scripts\bookheap-restart-check.mjs
node web\scripts\container-check.mjs
```

Real-server tests allocate an unused loopback port and isolated temporary data, then stop
the server and remove that data on teardown. The Bookheap restart check kills the server
during a 150-book assignment, verifies an unfinished job on disk, restarts it on the same
data, and checks that the heap, import jobs, library, shelf and heap folder agree. Redacted server diagnostics are saved under
`web/test-results/`. `PANDA_E2E_PORT` can override the allocated port. Container checks use
Docker by default; set `CONTAINER_ENGINE=podman` for Podman (the checker explicitly builds
Docker-format metadata to preserve the healthcheck).

SQL migrations are under [internal/db/migrations](internal/db/migrations/). Useful
operator commands are `pandalibrary migrate status`, `pandalibrary migrate up`, and
`pandalibrary migrate down-to <version>` (development only). Internal developer notes
(architecture, decisions, plans and task history) are kept locally in `docs/dev/`, which
is Git-ignored and not published.
