# PandaLibrary web

This SvelteKit SPA is built into static assets in `build/` and embedded by the Go
application.

From the repository root:

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir web dev
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
```

The development server proxies `/api`, `/opds`, and `/kosync` to
`http://127.0.0.1:8080`. Set `VITE_API_PROXY_TARGET` to override the backend URL.
Playwright is configured for later end-to-end tasks; its browser installation is separate
from the default unit-test command.
