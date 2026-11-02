# PandaLibrary

Self-hosted ebook library: a single Go binary with an embedded SvelteKit PWA, SQLite,
OPDS 1.2, KOReader sync, and EPUB/MOBI/AZW3/FB2/CBZ/PDF readers in the browser.

Status: design complete, project not scaffolded yet. See [docs/progress](docs/progress/README.md).

- [docs/](docs/README.md): architecture, decisions (ADRs), plans, prompts, progress
- [internal/db/migrations/](internal/db/migrations/): the database schema (goose migrations,
  applied automatically on startup)
