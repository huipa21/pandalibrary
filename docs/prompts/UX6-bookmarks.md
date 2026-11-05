# UX6: Saved reading-position bookmarks, reader UI, and cross-book page

- Status: Done
- Wave: 2; dependencies merged: UX1, UX2
- Migration: yes, sole writer in this wave (after UX2's migration)
- Branch/worktree: `task/ux6` / `..\pandalibrary-ux6`

## Read first and ownership

Read [the plan](../plans/sidebar-dashboard-plan.md), R1/W2/W3 hand-offs,
reading sync and visibility code, reader locators, IndexedDB/outbox/account
isolation, highlights/tombstones, and migration policy.
Own bookmark-specific backend/HTTP/query files, necessary localized
reading/sync contract extensions, one new migration/checksum/models,
`web/src/lib/bookmarks/**`, `/bookmarks/**`, the reader route's bookmark
controls, necessary reader/sync type/store changes, and dedicated tests.
Add a mount line in app.go if needed and `ux6.*` messages.
Do not modify shelves, dashboard, admin, shell/theme, or build files.

## Implement

1. Add real per-user saved positions, not Favorites aliases, empty highlights,
   browser-only storage, or a relabeled notes search. Store UUIDv7 identity,
   book/file identity, validated locator, normalized position, optional short
   label/chapter, timestamps, revision, and deletion tombstone.
2. Integrate with existing sync push/pull and per-book state. Reuse monotonic
   revisions, LWW/timestamp policy, validation, idempotency, and tombstones.
   Preserve compatibility for older clients and existing entities. Decide and
   test how older cached snapshots without a bookmarks field are interpreted.
3. Add account-scoped `GET /api/v1/me/bookmarks?limit=&cursor=&book_id=`
   for live bookmarks across books, ordered newest created/ID first.
   Return `{items,next_cursor}`; include bookmark identity/locator and a safe
   visible book summary for display/resume, with exact DTO in hand-off.
   Use opaque viewer/filter-bound cursors and existing limits. Never return
   another user's bookmarks or hidden/inaccessible book metadata.
4. Reader controls save the current position, list bookmarks, jump accurately,
   edit labels, and remove with clear feedback. Support existing reflowable
   CFI and PDF locators; distinguish file changes or unavailable files instead
   of jumping to an invalid position. Prevent duplicate in-flight submissions.
5. `/bookmarks` lists, pages, opens/resumes, renames, and removes saved positions
   with book title/cover and position/label. Preserve explicit states and
   keyboard/English/Chinese accessibility.
6. Extend IndexedDB/store upgrade, snapshot handling and durable offline outbox
   so offline bookmark creates/updates/deletes survive reload and sync later.
   Account changes/deletion clear or isolate cached bookmarks. Avoid blanket
   cache resets or existing reader-data loss during upgrade.
7. Keep mutation and read ACL enforcement on the server. Validate IDs, locator
   payload/length, file-book relationship, ownership, labels and limits.
   Account/book deletion and maintenance tombstone retention remain coherent.

## Acceptance and validation

Test PDF/CFI saves and jumps, page ordering, stale/idempotent edits/deletes,
sync propagation/tombstones, offline reload/outbox replay, IndexedDB upgrade
with old data, account isolation, hidden books, invalid locators/files, and
non-admin access. Preserve existing reading/sync/OPDS/KOReader behavior.
Run focused Go tests, migration/sqlc checks, Go build/lint/tests, frontend
check/units/build, and focused real-server reader/bookmark/offline browser
tests. Record schema/DTO/sync compatibility and exact results in the hand-off;
update your progress row/log.

## Implementation hand-off

- Migration 00003 stores bookmarks separately from highlights/Favorites.
  Push/pull and per-book state include `bookmarks`; older clients may omit
  the field. Version-1 IndexedDB row/outbox stores need no destructive schema
  migration; tests reopen legacy notes/settings and retain queued bookmark UUIDs.
- `GET /api/v1/me/bookmarks?limit=20&cursor=...&book_id=...` returns
  `{items,next_cursor}`. Each item contains `id`, `book_id`, nullable
  `book_file_id`, `locator`, `position`, `label`, nullable `chapter`,
  `created_at`, `updated_at`, nullable `deleted_at`, `rev`, and
  `book:{id,title,cover_url}`. Only visible live rows are listed, ordered by
  created time/UUID descending. Cursors bind viewer, role and book filter.
- Locators are `{type:"cfi",value:"epubcfi(...)"}` for reflowable files and
  `{type:"pdf",page:1,rects?:[...]}` for PDFs; file/format/ownership and size
  checks remain server-authoritative. Updates use monotonic revisions/LWW,
  UUID retries are idempotent and tombstones retain 180 days.
- Reader saves, label-only edits, deletion and exact cross-book opening are
  bilingual; label edits retain the original locator. Offline changes survive
  reload and replay after reconnect; account changes isolate data.
- Validation: focused bookmark/HTTP/maintenance/sync tests, full Go/sqlc gates,
  frontend check/204 units/build, real PDF/CFI saves/jumps, label-position
  preservation, offline reload/outbox replay and second-session deletion.
  Full integration/release commands are recorded in the UX10 hand-off.
