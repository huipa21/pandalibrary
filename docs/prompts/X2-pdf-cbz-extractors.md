# X2: PDF and CBZ extractors

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § X2
- Depends on (merged): X1
- Can run in parallel with: R1, W1, X3
- Branch / worktree: `master` (existing workspace)
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 7, 15
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md) and
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md)
- X1's `internal/extract/types.go`, `archive.go`, `registry.go`, `sniff.go`,
  `epub/epub.go`, `internal/covers/`, and extraction tests

## Goal

Register bounded PDF and CBZ metadata extractors with the common X1 extraction system.
They must return the shared `extract.Metadata` shape, preserve safe parsing behavior, and
provide representative fixture-based tests for import tasks that follow.

## Scope

**Owns (create/modify freely):**
- `internal/extract/pdf/**`
- `internal/extract/cbz/**`
- Small package-local fixtures under `internal/extract/pdf/testdata/` and
  `internal/extract/cbz/testdata/`

**Shared files (append-only, see plan §4):**
- `go.mod` / `go.sum` — add only the PDF parser dependency required by the accepted
  architecture
- [progress/README.md](../progress/README.md) — edit only the X2 row and append an X2 log

**Must not touch:**
- `internal/extract/types.go`, `sniff.go`, registry behavior, EPUB, or X1 tests except to
  report a concrete blocker
- `internal/covers/**`, importer, blobstore, database, HTTP handlers, or app wiring
- `web/**` or the architecture/decision documents unless an accepted design inconsistency
  is found

## Requirements

1. Implement package registration functions `pdf.Register(*extract.Registry) error` and
   `cbz.Register(*extract.Registry) error`, matching `epub.Register`. Implement the
   existing `extract.Extractor` signature and return the shared metadata type. The caller
   invokes each registered extractor through `Registry.Extract`, which provides the
   common timeout and panic recovery.
2. PDF extraction uses pdfcpu (pure Go) to read the PDF Info dictionary fields Title,
   Author, Subject, Keywords and page count. Map them to title, author, description,
   tags, and `PageCount` as appropriate. Do not render a PDF cover server-side; PDF covers
   are rendered by pdf.js in the browser in a later task. Reject malformed, unsupported,
   encrypted, or invalid PDFs with an explicit error and never return partial metadata as
   success. Enforce parser resource limits and honor context cancellation where supported.
3. CBZ extraction uses `extract.OpenArchive`; never extract files to disk. Read bounded
   `ComicInfo.xml` when present and map Title, Series, decimal Number, Writer, Summary,
   Year/Month/Day, Publisher, LanguageISO, Genre/Tags, and PageCount to common metadata.
   If `ComicInfo.xml` is absent, tolerate it and use the cleaned filename as the title.
4. Sort CBZ image members in deterministic natural filename order. Select the image at
   the `Image` index of the `ComicInfo.xml` page whose `Type` is `FrontCover`, when that
   index is valid; otherwise use the first image in that order. Return the original
   bounded image bytes in `Metadata.Cover`; cover normalization is performed by
   `internal/covers` downstream. Reject invalid or oversized cover entries with an
   explicit error.
5. Respect the shared ZIP path, entry count, per-entry, and total-uncompressed-size checks
   from X1. Bound XML and image reads with the existing extraction limits. Do not trust
   archive member names as file paths, accept duplicate/unsafe members, or read an
   unbounded XML document.
6. Preserve X1's typed error conventions (`ErrInvalidInput`, `ErrUnsupportedFormat`,
   `ErrTooLarge`) and wrap useful format context. Return zero metadata on every error.
   Keep both packages independent of database, HTTP, app, and future importer packages.
7. Add representative tiny PDF and CBZ fixtures or deterministic test-generated fixtures.
   Tests must cover successful metadata/page count extraction, absent optional fields,
   filename fallback, CBZ ComicInfo and cover fallback ordering, malformed files/XML,
   encrypted or unsupported PDF inputs, unsafe/oversized ZIP entries, and registration
   through the shared registry. Fixtures must stay small and contain no copyrighted book
   content.

## Out of scope

- Browser-rendered PDF covers
- MOBI/AZW3, FB2/FBZ extraction (X3)
- Import pipeline, file storage, duplicate detection, database writes, or HTTP APIs
- Changes to common X1 extraction APIs or archive policy

## Acceptance criteria

- [x] `pdf.Register` and `cbz.Register` work with the shared registry and sniffed formats.
- [x] PDF metadata and page count are extracted without server-side cover rendering.
- [x] CBZ metadata, decimal series number, page count, and deterministic cover selection
  follow the architecture.
- [x] Invalid, encrypted/unsupported, oversized, and unsafe inputs produce explicit
  errors and no partial metadata.
- [x] Fixture tests cover success and the required failure/edge cases.
- [x] `task build`, `task lint`, and `task test` pass, or any unrelated pre-existing
  repository blocker is recorded without changing out-of-scope files.

## Validation commands

```powershell
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and X2's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Uses `github.com/pdfcpu/pdfcpu` v0.16.4. Register the extractors independently with
  `pdf.Register(registry)` and `cbz.Register(registry)`; each returns any registration
  error, and neither package requires application wiring.
- Dependency and registration details are recorded above for I1. Do not wire a global
  registry into the application in this task.
- Update architecture docs or add an ADR only if the accepted design changes.
