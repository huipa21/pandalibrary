# Agent Instructions — PandaLibrary

## Stack & Structure
- **Backend:** Go 1.27 (`chi/v5`, `modernc.org/sqlite`, `goose/v3`, `fsnotify`, `pdfcpu`).
- **Frontend (`web/`):** Svelte 5 + SvelteKit 3 (`adapter-static`) + TypeScript + Tailwind CSS 4 + Paraglide JS i18n, managed with `pnpm`.
- **Container:** Built via `scripts/build-container.mjs` (`scratch` runtime, UID/GID 65532).

## Code Exploration & Editing (Token Efficiency)
- **Use AST symbols before full-file reads:** Call `list_symbols`, `find_definition`, `find_callers`, `find_callees`, and `get_symbol_body` (`pi-tree-sitter`) before reading entire `.go` or `.ts` files.
- **Svelte files (`.svelte`):** `pi-tree-sitter` supports `.go` and `.ts`/`.js`; use `rg` and targeted line ranges with `read` for `.svelte` components.
- **Ignore generated files:** Do not read or edit `web/src/lib/paraglide/**` directly—those files are auto-generated from `web/project.inlang`.
- **Syntax validation:** Rely on `pi-tree-sitter` pre-write validation for Go/TS edits and fix reported errors in the same turn.

## Build, Typecheck & Test Commands
- **Go tests:** Run targeted package tests first (`go test ./internal/...`). For full suites, run `go test ./... | tail -50` so `pi-tool-guard` archives the complete output while keeping context compact.
- **Frontend typecheck (`web/`):** Run `pnpm --dir web check` (compiles Paraglide messages, runs `svelte-kit sync`, and executes `svelte-check`). Never use `pnpm --dir web check:watch`.
- **Frontend unit tests (`web/`):** Run `pnpm --dir web test` (`vitest run`). Only run `pnpm --dir web test:e2e` (Playwright) when explicitly requested.
- **Frontend build (`web/`):** Run `pnpm --dir web build`.

## Security
- Never echo one-time `/setup` tokens, session secrets, or unredacted server startup logs in responses.

