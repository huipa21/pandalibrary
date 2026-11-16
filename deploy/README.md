# Container deployment

Build `localhost/pandalibrary:latest` from the repository root:

```sh
node scripts/build-container.mjs --tag localhost/pandalibrary:latest
```

The build script selects a working Docker or Podman engine, preferring Docker.
Set `CONTAINER_ENGINE=podman` if both are available and you want to use Podman's
image store. Run the following Compose commands with the same engine used to
build the image. `podman compose` requires a Compose provider.

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
configuration. On that network, configure Caddy with:

```caddyfile
books.example.org {
    reverse_proxy pandalibrary:8080
}
```

Replace the example domain and restrict network access to trusted containers.
On a new installation, open `https://books.example.org/setup` and use the
one-time token from the server logs. Treat the logs as credentials.

If Caddy's address changes, you can inspect the network subnet with
`podman network inspect pandalibrary-proxy` and use its CIDR in
`PANDA_TRUSTED_PROXIES`. Trusting a subnet trusts **every** container on it to
send forwarded headers, so use a dedicated network with only trusted containers.
Recheck the subnet if the network is recreated. After changing `.env`, run
`podman compose up -d` again to apply the new environment.

The reader's dictionary lookup uses an online dictionary API. Configure its
address and optional key on **Admin → Dicts** after setup; see the
[dictionary documentation](../docs/user/administration.md#dictionaries) for
the required API.
