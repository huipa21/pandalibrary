# X1: Extraction core, EPUB, and covers

- Status: Done
- Plan entry: [implementation-plan.md](../plans/implementation-plan.md) § X1
- Depends on (merged): F1
- Can run in parallel with: F2, F3
- Branch / worktree: `task/x1` in `..\pandalibrary-x1`
- Migration: no

## Read first

- [architecture/system.md](../architecture/system.md) §§3, 7–8, 15
- [architecture/database.md](../architecture/database.md) §§3, 4
- [ADR-0002](../decisions/0002-single-binary-go-sqlite.md)
- [ADR-0006](../decisions/0006-koreader-sync-compat.md)
- [implementation-plan.md](../plans/implementation-plan.md) §§1, 3–5
- [progress/README.md](../progress/README.md)
- The merged F1 Go module, package layout, and test conventions

## Goal

Build the format-independent extraction foundation, a secure EPUB2/3 metadata and cover
extractor, cover normalization, and KOReader's partial-MD5 helper. Later importer and
format tasks must be able to use these packages without coupling extraction to the
database, HTTP server, or storage implementation.

## Scope

**Owns (create/modify freely):**
- `internal/extract/` core types, format sniffing, registry, and `epub/`
- `internal/covers/`
- Package-local extraction and cover fixtures under `internal/extract/testdata/` and
  `internal/covers/testdata/`
- The KOReader partial-MD5 helper in the extraction package

**Shared files (append-only, see plan §4):**
- `go.mod` / `go.sum` — add only dependencies required by the extractors/decoders

**Must not touch:**
- `internal/db/`, migrations, `sqlc.yaml`, or Taskfile targets
- `internal/importer/`, blobstore, HTTP handlers, or application wiring
- Later format packages (`pdf/`, `cbz/`, `mobi/`, `fb2/`) beyond registering clean
  extension points for them
- `web/` or architecture/decision documents unless an accepted design inconsistency is
  found; report such an inconsistency instead of silently changing the design

## Requirements

1. Define a shared `Metadata` type for the fields required by the architecture's import
   pipeline: title, authors and roles, language, publisher, date, description,
   identifiers, tags, series and series index, page count where available, and optional
   cover bytes. Use types that preserve missing values and decimal series indices; do
   not invent database or API DTO dependencies.
2. Implement magic-byte/container sniffing and a format registry for EPUB, PDF, MOBI,
   AZW3, FB2, FBZ, and CBZ. This task implements only EPUB extraction; other recognized
   formats must return a clear unsupported/not-yet-registered result rather than a
   success-shaped empty `Metadata`.
   - EPUB is a ZIP whose `mimetype` entry identifies `application/epub+zip`.
   - PDF begins with `%PDF-`.
   - MOBI/AZW3 has `BOOKMOBI` at offset 60; distinguish KF8/AZW3 from MOBI using its
     header/version or KF8 boundary.
   - FB2 is XML with a `FictionBook` root; FBZ is a ZIP containing an `.fb2`.
   - CBZ is a ZIP containing image entries.
3. Apply shared archive safety limits: bound entry count, per-entry uncompressed size,
   and total uncompressed size; reject path traversal/invalid archive structures; never
   use archive paths as filesystem destinations. Use clear typed errors for invalid,
   unsupported, oversized, and timed-out inputs.
4. Wrap extractor execution with a context timeout and panic recovery. A panic or timeout
   must become an explicit error and must not return partial metadata as if extraction
   succeeded. Keep the wrapper reusable by later format packages.
5. Implement EPUB2/3 extraction by resolving `META-INF/container.xml` to the OPF and
   parsing XML safely. Extract:
   - title and subtitle where available;
   - creators with role and file-as, including EPUB3 `refines`;
   - language, publisher, date, description, identifiers with ISBN detection, and
     subjects as tags;
   - series from Calibre metadata or EPUB3 `belongs-to-collection` and `group-position`;
   - cover in priority order: EPUB3 `cover-image` property, EPUB2 `<meta name="cover">`,
     then guide cover.
   Resolve referenced archive resources safely and tolerate optional/missing fields;
   return a clear parse error for malformed required structure. Fall back to the cleaned
   filename for title only when metadata has no usable title.
6. Normalize covers in `internal/covers`: decode JPEG, PNG, GIF, or WebP; produce a
   full-size JPEG no larger than 1200 px on its longest edge and a 400 px thumbnail;
   preserve aspect ratio, handle transparency against a documented background, and
   return hashes of the output bytes for content-addressed storage. Do not add file I/O
   or database behavior to the package.
7. Implement the KOReader default Binary partial MD5 exactly as described in
   [system.md](../architecture/system.md) §8: sample up to 1024 bytes at offset 0 and
   offsets `1024 << (2*i)` for `i = 0..10`, stopping at EOF, and return the lowercase
   digest. Handle short files and reader errors correctly; do not modify input bytes.
8. Add small, representative EPUB2 and EPUB3 fixtures covering metadata, series,
   identifier, and cover fallbacks. Add tests for each sniff signature, unsupported
   dispatch, malformed/oversized archives, timeout/recovery behavior, cover resizing
   and thumbnail generation, and partial MD5 edge cases.
9. Verify the partial-MD5 test against a known KOReader-compatible value computed
   independently of the implementation under test. Document the fixture and expected
   value's provenance in the test.
10. Keep package APIs suitable for later extractor registration and keep all parsing
    bounded. Do not add network access, disk writes, or dependencies on future
    application packages.

## Out of scope

- PDF, CBZ, MOBI/AZW3, FB2/FBZ extraction (X2 and X3)
- Import pipeline, file hashing/storage, duplicate detection, database writes, or jobs
- Browser-side PDF cover rendering and upload
- Metadata providers or user-facing APIs

## Acceptance criteria

- [x] Core extraction packages compile without CGO and expose reusable metadata,
  sniffing, registry, and safe execution APIs.
- [x] EPUB2/3 fixture tests cover required metadata and all cover-selection fallbacks.
- [x] Invalid, oversized, unsupported, panicking, and timed-out inputs return explicit
  errors without success-shaped partial results.
- [x] Cover normalization creates valid JPEG full and thumbnail outputs at the required
  dimensions and reports stable content hashes.
- [x] Partial MD5 matches an independently verified KOReader value, including short-file
  and sparse/large-offset cases.
- [x] `task build`, `task lint`, and `task test` pass from the repository root.
- [x] No database, web, importer, or later-format implementation is added by X1.

## Validation commands

```powershell
task build
task lint
task test
```

## Hand-off

- Update this prompt's status and X1's row and dated log entry in
  [progress/README.md](../progress/README.md).
- Extractor packages register with `extract.Registry.Register`; EPUB exposes
  `epub.Register`. `Registry.Extract` sniffs a `io.ReaderAt` plus size, then applies the
  shared timeout and panic recovery. Until registered, recognized non-EPUB formats return
  `ErrNotRegistered` and `ErrUnsupportedFormat`.
- Reuse `extract.OpenArchive` and its `MaxArchiveEntries`, `MaxEntryUncompressed`,
  `MaxArchiveUncompressed`, and `MaxCompressedInput` limits. Package fixtures live under
  `internal/extract/testdata/`; EPUB fixtures are XML resources assembled into ZIP
  archives in tests. No archive member name is a filesystem destination.
- `task build`, `task lint`, and `task test` pass from the repository root.
- Follow-up (2026-11-04): shared FB2 sniffing now recognizes an initial UTF-8 BOM and
  uses `charset.NewReaderLabel` for declared encodings, allowing plain BOM and
  Windows-1251 FB2 registry dispatch. The formerly skipped X3 registry tests now run.
- Update architecture docs or add an ADR only if the accepted design changes.
