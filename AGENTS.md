# Agent Instructions — PandaLibrary

## Stack & Structure
- **Backend:** Go 1.27 (`chi/v5`, `modernc.org/sqlite`, `goose/v3`, `fsnotify`, `pdfcpu`).
- **Frontend (`web/`):** Svelte 5 + SvelteKit 3 (`adapter-static`) + TypeScript + Tailwind CSS 4 + Paraglide JS i18n, managed with `pnpm`.
- **Container:** Built via `scripts/build-container.mjs` (`scratch` runtime, UID/GID 65532).

## Code Exploration & Editing (Token Efficiency)
- **AST symbols first:** Call `list_symbols`, `find_definition`, `find_callers`, `find_callees`, and `get_symbol_body` (`pi-tree-sitter`) before reading entire `.go` or `.ts` files.
- **Svelte files (`.svelte`):** Use `rg` and targeted line ranges with `read`.
- **Ignore generated files:** Never read or edit `web/src/lib/paraglide/**` directly—those files are generated from `web/project.inlang`.
- **Syntax validation:** Rely on `pi-tree-sitter` pre-write validation for Go/TS edits and fix reported errors in the same turn.

## Build, Typecheck & Test Commands
- **Go tests:** Run targeted package tests first (`go test ./internal/...`). For full suites, run `go test ./... | tail -50` so `pi-tool-guard` archives the complete output while keeping context compact.
- **Frontend typecheck (`web/`):** Run `pnpm --dir web check` (compiles Paraglide messages, runs `svelte-kit sync`, and executes `svelte-check`). Never use `pnpm --dir web check:watch`.
- **Frontend unit tests (`web/`):** Run `pnpm --dir web test` (`vitest run`). Only run `pnpm --dir web test:e2e` (Playwright) when explicitly requested.
- **Frontend build (`web/`):** Run `pnpm --dir web build`.

## Paragraph Decomposition & Wave Orchestration (`pi-subagents`)
Delegation to subagents is explicitly authorized for multi-part requests. When the user sends a dense paragraph or multiple requests in one prompt, execute this workflow before editing code:

1. **Activate Subagents:** If `subagent` is not yet active in this session, call `subagents_enable({})` immediately.
2. **Parse & Summarize Tasks:** Read the entire user message carefully, extract every distinct requirement (even if written as a single unformatted paragraph), and output a brief numbered task list (`T1`, `T2`, `T3`...) showing:
   - **Goal:** One-line summary of the change or question.
   - **Scope:** Target files/directories (`internal/...`, `web/src/...`, or `read-only`).
   - **Dependencies:** Which earlier task IDs (if any) must finish first.
3. **Classify & Partition Waves:**
   - **Wave 1 (Parallel Fan-Out):** Group all read-only discovery tasks (`scout`) and all independent write tasks (`worker`) with disjoint file paths. Dispatch them simultaneously in parallel (up to 6–8 concurrent subagents) with self-contained prompts, exact file boundaries, and instructions not to run full test suites inside workers.
   - **Wave 2 (Dependent / Same-File Tasks):** Queue tasks that edit the same file as a Wave 1 task or depend on a new Wave 1 Go API endpoint/TypeScript type to run sequentially after their dependency completes.
   - **Single-Task Fallback:** If the prompt contains only one small, localized edit, execute it directly without spawning subagents.
4. **Single Verification Gate:** After all waves finish, run the relevant commands from **Build, Typecheck & Test Commands** once in the parent session (`go test ./... | tail -50`, `pnpm --dir web check`, `pnpm --dir web test`, and `pnpm --dir web build` when needed).
5. **Optional Audit:** For complex cross-stack changes, run a `reviewer` subagent on the final diff before summarizing.

## Security
- Never echo one-time `/setup` tokens, session secrets, or unredacted server startup logs in responses.

