# Dev hot-reload (no container rebuild)

Run the backend and the Vite dev server together with `deploy/dev.sh`. State
(pids, logs, compiled binary) lives in `deploy/.dev/`, which is git-ignored:

```sh
./deploy/dev.sh start      # build + start backend (127.0.0.1:8080) and Vite (0.0.0.0:5173)
./deploy/dev.sh status
./deploy/dev.sh logs       # follow both logs, or: logs backend | logs frontend
./deploy/dev.sh restart-backend   # after Go edits
./deploy/dev.sh stop
```

Frontend edits hot-reload through Vite, which proxies `/api`, `/opds`, and
`/kosync` to the backend. Open `http://localhost:5173` from the Windows browser.
Override defaults with environment variables: `PANDA_DEV_LISTEN`,
`PANDA_DEV_BASE_URL`, `PANDA_DATA_DIR`, `PANDA_DEV_VITE_HOST`,
`PANDA_DEV_VITE_PORT`, `PANDA_DEV_READY_TIMEOUT`.

# Container deployment

Build `localhost/pandalibrary:latest` from the repository root. This is the
build script's default tag:

```sh
node scripts/build-container.mjs
```

If the default package registries are slow or blocked, point the build at
reachable mirrors. Use registries you trust:

```sh
NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
GOPROXY=https://goproxy.cn,direct \
  node scripts/build-container.mjs
```

The build script passes
`NPM_REGISTRY`, `GOPROXY`, and `GOSUMDB` to Docker when the matching
environment variables are set. `NPM_CONFIG_REGISTRY` is passed as
`NPM_REGISTRY`.

The build script selects a working Docker or Podman engine, preferring Docker.
Set `CONTAINER_ENGINE=podman` if both are available and you want to use Podman's
image store. Run the following Compose commands with the same engine used to
build the image. `podman compose` requires a Compose provider.

### Local HTTP-only test

For local testing without Caddy, use `docker-compose.dev.yml`. It publishes
`127.0.0.1:8080`, sets `PANDA_BASE_URL=http://localhost:8080`, disables
forwarded-header trust, and uses the same `./data` bind mount. From this
directory:

```sh
mkdir -p data
chmod 700 data
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml logs -f pandalibrary
```

Open `http://localhost:8080/setup` and use the one-time token from the logs.
This runs the production image with an HTTP-only origin; it is not the Vite
hot-reload workflow. To change the host port, set `PANDA_DEV_PORT` and keep
`PANDA_DEV_BASE_URL` in sync:

```sh
PANDA_DEV_PORT=8081 PANDA_DEV_BASE_URL=http://localhost:8081 \
  docker compose -f docker-compose.dev.yml up -d
```

To test from another device on a trusted LAN, bind the host address and use
the same address in the base URL:

```sh
PANDA_DEV_BIND=0.0.0.0 PANDA_DEV_BASE_URL=http://192.0.2.10:8080 \
  docker compose -f docker-compose.dev.yml up -d
```

This publishes plain HTTP with no TLS. Do not expose it to the public internet.
If the host user is not UID/GID `1000`, set `PANDA_DEV_UID` and `PANDA_DEV_GID`
to match, or make `data` writable by the selected IDs.

Create `data` inside this directory, and make it and its
contents writable by UID/GID `1000:1000`. With rootless Podman on Linux, uncomment
`userns_mode: keep-id` in the Compose file if the host user has those IDs.
On SELinux-enabled Linux, the bind mounts may need the `:Z` option. On Windows,
Podman VM bind-mount permissions and ID mapping can differ.

An existing library database goes at `data/pandalibrary.db`; copy it only while
the source is stopped or use a consistent SQLite snapshot. Restore the other
managed files too. Do not replace the database while the server is running.

Copy `.env.example` to `.env` in this directory and replace the example URL
with your actual public HTTPS origin:

```dotenv
PANDA_BASE_URL=https://books.example.org
```

The application can run without this variable, but this Compose configuration
requires it to enable secure cookies and validate the public origin.

`PANDA_TRUSTED_PROXIES` is optional. When unset, PandaLibrary ignores forwarded
client IP and scheme headers and sees Caddy as the client. This can cause
IP-based login and API rate limits to be shared by users behind Caddy. To use
the forwarded addresses, set it to comma-separated CIDRs for trusted proxies
that sanitize forwarded headers.

From this directory, start the service:

```sh
podman compose up -d
podman compose logs pandalibrary
```

The service has no published host port. Connect your existing Caddy container to
the `pandalibrary-proxy` network created by Compose, using the same container
engine, for example `podman network connect pandalibrary-proxy <caddy-container>`.
Alternatively, add that network as an external network to Caddy's Compose
configuration. On that network, use the ready-to-copy site block in
[`pandalibrary.caddy`](pandalibrary.caddy). It keeps
`/api/v1/books/*/files/*` out of Caddy's `encode` middleware so the reader's
`Range`/`If-Range` requests still receive `206 Partial Content`, and PDF/EPUB
responses are never gzipped. Copy it to
`/etc/caddy/conf.d/pandalibrary.caddy` and replace `books.example.org`; it
assumes the main Caddyfile defines the `logs`, `hardening`, and `proxy_headers`
snippets and imports `conf.d/*.caddy`.

Replace the example domain and restrict network access to trusted containers.
On a new installation, open `https://books.example.org/setup` and use the
one-time token from the server logs. Treat the logs as credentials.

If Caddy's address changes, you can inspect the network subnet with
`podman network inspect pandalibrary-proxy` and use its CIDR in
`PANDA_TRUSTED_PROXIES`. Trusting a subnet trusts **every** container on it to
send forwarded headers, so use a dedicated network with only trusted containers.
Recheck the subnet if the network is recreated. After changing `.env`, run
`podman compose up -d` again to apply the new environment.

The reader's dictionary lookup uses online dictionary providers. Enter
Merriam-Webster API keys or add custom dictionary APIs on **Admin → Dicts**
after setup; see the
[dictionary documentation](../docs/user/administration.md#dictionaries).
Lookup responses are cached in `data/dictionaries/cache.db`. The cache is not
part of backups and can be deleted safely.
