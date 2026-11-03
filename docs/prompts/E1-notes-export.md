# E1: Notes export

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § E1
- Depends on (merged): R1
- Can run in parallel with: ST1, O1, W4
- Branch / worktree: `task/e1` in `..\pandalibrary-e1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 5–6, 8, 13
- [architecture/database.md](../architecture/database.md) §§1–3, 5–6, 8
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md), and
  [R1's annotation DTO and visibility contracts](./R1-reading-sync-api.md)
- `internal/reading/`, `internal/catalog/`, `internal/blobstore/`,
  `internal/httpapi/reading.go`, generated sqlc code, and current app mount wiring

## Goal

Let an authenticated user download their own live notes and highlights as Obsidian-ready
Markdown. A single selected book downloads as a Markdown attachment; a bounded selection
of multiple books downloads as a ZIP with portable, collision-safe filenames.

## Scope

**Owns (create/modify freely):**
- `internal/export/**`
- Export query code required by the task under `internal/db/queries/export.sql` and
  generated sqlc output from `task sqlc`
- Export HTTP handler and tests under `internal/httpapi/`
- Export-specific tests in the owned packages

**Shared files (append-only, see plan §4):**
- `internal/app/app.go` — construct the export service and append its mount
- `internal/db/sqlc/**` — generated output only; run `task sqlc`
- `go.mod` / `go.sum` — only if a directly required dependency is missing
- [progress/README.md](../progress/README.md) — edit only the E1 row and append an E1 log

**Must not touch:**
- `internal/db/migrations/**`, annotation editing/sync semantics, or book visibility rules
- Reader or notes UI (W2/W7), stats (ST1), OPDS (O1), or unrelated API DTOs
- Existing catalog or reading behavior

## Requirements

1. Add authenticated `GET /api/v1/me/notes/export?book_ids=ID[,ID...]`. Require exactly
   one `book_ids` parameter containing 1–100 distinct positive decimal book IDs; reject
   empty, malformed, duplicate, or over-limit selections with 400. Derive the user only
   from the authenticated viewer. Return 404 for a nonexistent, hidden, or inaccessible
   selected book without identifying which condition occurred.
2. Export only live notes and highlights belonging to the viewer and visible books.
   Include book-level notes (`highlight_id IS NULL`) and notes attached to live
   highlights. Do not export tombstones, another user's annotations, or hidden/inaccessible
   book metadata. A book with no annotations may produce a valid document with empty
   sections.
3. For one book, return UTF-8 `text/markdown; charset=utf-8` with an attachment name
   `<Title> - <Author>.md`. For multiple books, return
   `application/zip` with one Markdown document per selected book and a safe archive
   filename. Set `Content-Disposition` safely for Unicode titles and `Cache-Control:
   no-store`; do not include server filesystem paths.
4. Match the Obsidian document shape in
   [system.md](../architecture/system.md) §13: YAML frontmatter for title, ordered
   authors, optional series/index, ISBN when available, tags, PandaLibrary book ID, and
   export date; then `# <title>`, a Notes section, and a Highlights section. Order
   book-level notes newest first, highlights by `position` then stable ID, and attached
   notes deterministically. Include each highlight's text and stable `^hl-<id>` block ID,
   followed by its attached note body when present. Preserve Markdown note bodies as
   Markdown; do not render them as HTML.
5. Quote and escape frontmatter values as valid YAML so user-controlled titles, authors,
   identifiers, and tags cannot break document structure. Sanitize archive/member names
   for Windows, macOS, and Linux; remove path separators/control characters, avoid
   reserved device names, and resolve normalized-name collisions deterministically
   without overwriting entries.
6. Use bounded request and response generation. Query the selected books and annotations
   in bounded batches (no N+1 per-book reads); avoid holding unnecessary duplicate copies
   of large note bodies. Use read-only database access and sqlc conventions, and add no
   migration. Do not log note contents or include them in problem details.
7. Add golden Markdown tests for frontmatter escaping, book-level and highlight-attached
   notes, ordering, stable block IDs, and empty sections. Add ZIP tests for multiple books,
   safe filenames/collisions, invalid requests, ownership, visibility changes, tombstones,
   and attachment headers.

## Out of scope

- Editing, deleting, or syncing notes and highlights (R1)
- UI selection/download controls (W7)
- Importing into Obsidian or exporting book files
- Schema changes or export-format customization

## Acceptance criteria

- [x] A single visible book exports as the documented Markdown file.
- [x] Multiple visible books export as a valid ZIP with safe, unique member names.
- [x] Only the current user's live annotations on visible books are included.
- [x] Golden, ZIP, security-boundary, and HTTP tests pass.
- [x] `task sqlc:check`, `task build`, `task lint`, and `task test` pass.

## Validation commands

```powershell
task sqlc
task sqlc:check
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and E1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Record the response MIME types, selection limits, and filename behavior for W7.
- Update architecture docs or add an ADR only if the accepted export design changes.

## Implementation hand-off

- A one-ID request returns one Markdown attachment; a comma-separated selection of 2–100
  IDs returns a ZIP. All IDs must be visible to the caller; an invalid or inaccessible ID
  rejects the whole export rather than silently omitting a book.
- The frontmatter follows `system.md` §13. The generated filename is safe on all three
  major desktop platforms and remains unique inside a ZIP even when titles normalize to
  the same name.
- `GET /api/v1/me/notes/export` requires one `book_ids` query parameter containing 1–100
  distinct positive decimal IDs. One book returns `text/markdown; charset=utf-8`; multiple
  books return `application/zip`. Both use `Cache-Control: no-store` and safe attachment
  headers. Markdown names use `<Title> - <First Author>.md` (or `Unknown Author`); ZIP
  members are sanitized and collision-resolved case-insensitively after Unicode NFC.
- Generation is capped at 16 MiB of annotation text, 10,000 rows per annotation kind, and
  32 MiB of generated output.
