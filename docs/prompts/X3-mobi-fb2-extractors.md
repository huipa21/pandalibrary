# X3: MOBI/AZW3 and FB2/FBZ extractors

- Status: Done (unblocked; both plain-FB2 registry regressions pass, 2026-11-04)
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § X3
- Depends on (merged): X1
- Can run in parallel with: R1, W1, X2
- Branch / worktree: `task/x3` in `..\pandalibrary-x3`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 7, 8, 15–16
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5 and
  [progress/README.md](../progress/README.md)
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md),
  [ADR-0004](../decisions/0004-docs-structure-and-agent-workflow.md), and
  [ADR-0006](../decisions/0006-koreader-sync-compat.md)
- X1's `internal/extract/types.go`, `archive.go`, `registry.go`, `sniff.go`, `partialmd5.go`,
  EPUB extractor, fixtures, and tests

## Goal

Complete extraction support for MOBI, AZW3, FB2, and FBZ using the X1 format registry and
common metadata contract. Keep parsing bounded and safe, report DRM-protected files
clearly, and test format-specific metadata and encodings with small fixtures.

## Scope

**Owns (create/modify freely):**
- `internal/extract/mobi/**`
- `internal/extract/fb2/**`
- Small package-local fixtures under `internal/extract/mobi/testdata/` and
  `internal/extract/fb2/testdata/`

**Shared files (append-only, see plan §4):**
- `go.mod` / `go.sum` — add dependencies only if required; `golang.org/x/net/html/charset`
  is already available
- [progress/README.md](../progress/README.md) — edit only the X3 row and append an X3 log

**Must not touch:**
- `internal/extract/types.go`, `sniff.go`, registry behavior, EPUB, or X1 tests except to
  report a concrete blocker
- PDF/CBZ packages (X2), importer, blobstore, database, HTTP handlers, or app wiring
- `internal/covers/**` or web reader code

## Requirements

1. Implement registration functions for `mobi.Register(*extract.Registry) error` and
   `fb2.Register(*extract.Registry) error`. Register both `FormatMOBI` and `FormatAZW3`
   with the MOBI package, and both `FormatFB2` and `FormatFBZ` with the FB2 package.
   Match `epub.Register` and the common `extract.Extractor` signature. The shared registry
   supplies the execution timeout and panic recovery.
2. Parse Palm Database/MOBI structures with checked offsets and lengths; do not use
   unchecked slicing or allocate based on untrusted counts. Read the bounded first
   PalmDOC/MOBI record and EXTH records to extract title (503), author (100), publisher
   (101), description (103), ISBN (104), subjects (105), date (106), language (524), and
   cover offset (201) where available. Populate the matching common metadata fields.
3. Distinguish MOBI and AZW3 using X1's `Sniff` result; do not duplicate or change the
   shared sniff logic. Detect DRM/encryption flags before attempting to interpret
   protected content. Return a clear, stable error that lets the importer identify a
   DRM-protected file, wrapping the existing unsupported-format sentinel or defining a
   package-local sentinel as appropriate. Never return partial metadata on error.
4. If a MOBI/AZW3 cover offset resolves to a valid image record, return its bounded raw
   bytes in `Metadata.Cover`. Do not normalize or write the cover in this package.
   Validate record indexes and ranges before reading; absent or invalid optional cover
   metadata must not permit out-of-bounds reads.
5. Parse FB2 as a bounded streaming XML document and support UTF-8 plus common Windows-1251
   input through `golang.org/x/net/html/charset`. Populate title, authors, genres/tags,
   language, series name and decimal sequence number, annotation/description, publisher,
   year/date, ISBN, and cover bytes decoded from the referenced `<binary>` element. Bound
   decoded base64 cover size, reject unsafe XML directives, and return a clear parse error
   for malformed required structure.
6. Parse FBZ through `extract.OpenArchive` without writing files. Require a safely resolved
   `.fb2` member and feed its bounded contents through the same FB2 parser. If multiple
   FB2 entries make the source ambiguous, return an explicit invalid-input error rather
   than selecting an arbitrary member.
7. When metadata has no usable title, apply the same safe filename-cleaning behavior used
   by the EPUB extractor; keep any helper local to this task rather than modifying X1-owned
   files. Preserve shared archive entry/path limits, `MaxMetadataDocumentSize`, and
   `MaxCoverEntrySize`. Do not add filesystem writes, network access, database
   dependencies, or unbounded parsing.
8. Add small representative fixtures, including an FB2 in Windows-1251 and MOBI/AZW3
   examples that exercise EXTH records and DRM detection. Cover valid and invalid
   record tables, malformed/truncated headers, missing optional fields, series decimals,
   base64 cover handling and bounds, FBZ unsafe/missing/multiple members, and filename
   fallback. Confirm all four formats dispatch through the shared registry.

## Out of scope

- PDF/CBZ extraction (X2)
- Import pipeline, file storage, duplicate detection, DB writes, or HTTP APIs
- Reader-side MOBI/AZW3 rendering and KOReader protocol implementation
- Any schema migration or changes to shared extraction policy

## Acceptance criteria

- [x] MOBI, AZW3, UTF-8 FB2 with and without a BOM, Windows-1251 FB2, and FBZ register
  and dispatch through the common registry.
- [x] EXTH metadata, DRM rejection, FB2 CP1251 parsing, series, identifiers, and bounded
  covers behave as specified.
- [x] Invalid and oversized inputs fail explicitly and return no partial metadata.
- [x] Fixture tests cover each format and the listed safety/edge cases.
- [x] `task build`, `task lint`, and `task test` pass, or any unrelated pre-existing
  repository blocker is recorded without changing out-of-scope files.

## Validation commands

```powershell
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and X3's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Document all registration calls and the DRM error contract for I1 and the later reader
  task. Keep the format packages independently testable.
- Update architecture docs or add an ADR only if the accepted design changes.

### Implementation hand-off

- I1 should call `mobi.Register(registry)` and `fb2.Register(registry)`, checking both
  errors. They register MOBI/AZW3 and FB2/FBZ respectively; no application-wide registry
  is wired here. `errors.Is(err, mobi.ErrDRM)` identifies a protected MOBI/AZW3 file, and
  the same error also matches `extract.ErrUnsupportedFormat`.
- Direct FB2 extraction, FBZ registry dispatch, and plain FB2 registry dispatch accept
  Windows-1251 and UTF-8 with a BOM. The shared sniffer strips an initial UTF-8 BOM for
  signature detection and configures the bounded root decoder with
  `charset.NewReaderLabel`. The plain-registry regression tests run without skips.
- FB2 documents are limited to `MaxEntryUncompressed`, with the description limited to
  `MaxMetadataDocumentSize`, XML depth to 256, and decoded covers to
  `MaxCoverEntrySize`. MOBI cover records are returned unmodified after image validation
  using the existing `covers.MaxInputPixels` limit. `golang.org/x/net/html/charset`
  requires the added indirect `golang.org/x/text v0.43.0` module.
- `task build`, `task lint`, and `task test` pass; focused boundary, cancellation, and
  fuzz tests pass.
- Shared-sniffer revalidation (2026-11-04): `TestWindows1251PlainFB2Registry` and
  `TestUTF8BOMFB2AndFBZ/plain_registry` both pass without skips. The focused
  `go test ./internal/extract ./internal/extract/fb2 -count=1` run and
  `task build`, `task lint`, `task test` also pass. X3 remains unblocked; this
  follow-up changed neither the FB2 extractor nor its tests.
