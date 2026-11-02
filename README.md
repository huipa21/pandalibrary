# PandaLibrary

Self-hosted ebook library: a single Go binary with an embedded SvelteKit PWA, SQLite,
OPDS 1.2, KOReader sync, and EPUB/MOBI/AZW3/FB2/CBZ/PDF readers in the browser.

Status: the repository scaffold exists; product implementation has not started yet.
See [docs/progress](docs/progress/README.md).

- [docs/](docs/README.md): architecture, decisions (ADRs), plans, prompts, progress
- [internal/db/migrations/](internal/db/migrations/): the planned database schema (goose
  migrations; automatic startup application is not implemented yet)

## Scaffold development

Install Go 1.27, [Task](https://taskfile.dev/), and
[staticcheck](https://staticcheck.dev/). CI uses these pinned tool versions:

```sh
go install github.com/go-task/task/v3/cmd/task@v3.54.0
go install honnef.co/go/tools/cmd/staticcheck@v0.8.2
```

Ensure the directory from `go env GOBIN`, or the `bin` directory under the first
`go env GOPATH` entry when `GOBIN` is unset, is on your `PATH`. From the repository root:

```sh
task build
task lint
task test
```

The build produces `pandalibrary` (`pandalibrary.exe` on Windows) with CGO disabled.
The default `serve` command, `migrate`, `healthcheck`, `user create`, and
`user reset-password` are stubs: each reports that it is not implemented and exits
unsuccessfully. No database, web client, or server behavior is implemented yet.
