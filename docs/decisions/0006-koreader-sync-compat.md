# ADR-0006: KOReader sync via the kosync protocol and partial-MD5 file identity

- Status: Accepted
- Date: 2026-11-02

## Context

Many users read on e-ink devices running KOReader. Their reading position should match the
web reader's.

## Decision

- Implement the kosync server protocol under `/kosync`, authenticated with per-user kosync
  app passwords.
- Identify documents by KOReader's default "Binary" partial MD5, computed at import time
  (`book_files.koreader_md5`). Files are served exactly as stored, never rewritten.
- Store the raw KOReader record so that KOReader-to-KOReader sync is exact. Map
  cross-reader positions by page (PDF/CBZ) or by chapter-level XPointer and percentage
  (reflowable formats).

Details: [architecture/system.md](../architecture/system.md) §8.

## Alternatives considered

- A custom KOReader plugin: users would have to install extra code on the device.
- The "Filename" checksum: file names differ between the server and the device.

## Consequences

- Moving from the web reader to KOReader on a reflowable book lands at the start of the
  chapter. This must be validated on a real device early (plan task K1).
- Writing metadata into files on download is not allowed.
