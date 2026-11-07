# BV7: Files tab

- Status: Ready
- Wave: 2. Dependencies merged: BV1, BV3, BV4
- Can run in parallel with: BV5, BV6, BV8, BV9
- Branch/worktree: `task/bv7` / `..\pandalibrary-bv7`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md): decisions 8 and 13, the BV1
  file fields, the UI kit, the book context.
- The BV1, BV3 and BV4 hand-offs in [progress/README.md](../progress/README.md).
- `web/src/lib/bookview/tabs/FilesTab.svelte` (placeholder). The legacy files
  section that BV4 moved into `DetailsTab.svelte` holds the read, download and
  offline save/remove logic to port: `downloadForOffline`, `downloadedBooks`,
  `removeBook` and `$offlineStatus`. Also read `web/src/lib/sync/library.ts`,
  `web/src/lib/sync/db.ts`, `web/src/lib/reader/api.ts` (`getBookState`) and
  `web/src/lib/sync/offline.e2e.ts`.
- Screenshot 6. A summary card shows a cover thumbnail, the title, the
  breadcrumb "library / author / file name", and FILES / TOTAL / FORMATS stats
  with a bar. On the left, a **Files** card "grouped by reader" has an EBOOK
  group with rows (a file icon with a format label, file name, `21% READ`
  chip, size, Resume and a kebab menu). On the right, a **This file** panel
  shows a large file icon, name, PRIMARY badge, path with copy, size, added,
  a progress ring "You are 21% through this copy · Last read …", and Resume,
  eye, download and kebab buttons. The Write-back card is out of scope.

## Goal

The Files tab lists every stored file of the book, grouped by reader type. It
shows per-file reading progress, and the read, download and offline
save/remove actions live here.

## Scope

**Owns:** `web/src/lib/bookview/tabs/FilesTab.svelte`,
`web/src/lib/bookview/files/**` (new: `FilesSummary.svelte`, `FileGroupList.svelte`,
`FileRow.svelte`, `FilePanel.svelte`, `FileMenu.svelte`, `ProgressRing.svelte`,
`files-model.ts` + tests, `files.e2e.ts`), and `bv7.*` messages.

**Must not touch:** `DetailsTab.svelte` (BV6 removes the legacy files section
there), other tabs, the kit internals, backend.

## Subtasks

### BV7.1 – Model

> Create `files-model.ts`. `readerGroup(format)` maps to `ebook` (epub, mobi,
> azw3, fb2, fbz), `document` (pdf) or `comic` (cbz). `buildFilesModel(book,
> progress, savedFileIds)` returns `{ groups: [{ key, files, count, bytes }],
> totalBytes, formats: [{ format, count }], primaryFileId }`. Groups are in
> the order ebook, document, comic, and files within a group follow
> `FORMAT_ORDER`, then name. The primary file is the progress file when
> present, else the preferred format. Each file carries `progress` (a fraction
> only when `progress.book_file_id === file.id`), `readable`
> (`readerFormat`) and `saved` (offline). Unit-test the grouping, ordering,
> primary choice and a missing progress file.

### BV7.2 – Summary and list

> `FilesSummary.svelte` is a `rounded-2xl border bg-white` card. It shows a
> `BookCover size="sm"` (w-12), the title, and a muted breadcrumb `library name
> / first author / primary original_filename` (each part truncates). It also
> shows the stats FILES (count), TOTAL (`formatSize`) and FORMATS (a segmented
> bar coloured by `formatTone` with the count), plus a **Sort** toggle (name
> / size / added) that only affects row order inside groups. `FileGroupList` is
> a card titled "FILES" with a muted "grouped by reader" note. Each group has a
> dot plus the uppercase group label and `N · size` on the right. Each
> `FileRow` is a button-like row (`aria-pressed` when selected, emerald tint
> background) with a file icon showing the format label, the
> `original_filename` (extension muted), an `x% READ` chip when it has
> progress, the size, a **Resume/Read** button (emerald, hidden when not
> readable), and a `FileMenu` kebab with Download, Save for offline / Remove
> offline copy (when offline storage is available and online) and Copy file
> name. Selecting a row updates the right panel. The primary file is selected
> initially.

### BV7.3 – This file panel

> `FilePanel.svelte` is a "THIS FILE" card showing: a large file icon tinted
> with the format tone, the name, a PRIMARY badge when it is primary, an
> OFFLINE badge when saved, and the name in a monospace field with a copy
> button (the name only; there is no server path). It lists Size and Added
> (`formatDate(created_at)`). When there is progress, it shows a
> `ProgressRing` (SVG, emerald, `role="img"` with an accessible label), "You
> are N% through this copy" and "Last read {relative}" (from
> `progress.updated_at`). Actions: **Resume/Read** (full width, emerald,
> `/read/{book}/{file}`), Download (a link to `download_url`, hidden offline)
> and a kebab (offline save/remove). Port the offline download/remove logic
> and messages exactly as the legacy page had them: the busy states, confirm
> before removing, the success and failure notices, and a reload of the book
> context after removal when it was loaded offline. Load progress via
> `getBookState` online, or the synchronized offline `readerState` when
> offline. Refresh on `BOOK_STATE_CHANGED_EVENT`.

### BV7.4 – Layout and tests

> `FilesTab.svelte` is a 2-column grid on `lg` (`1fr 24rem`) and stacked on
> mobile. Write `files.e2e.ts` (mocked API) covering: grouping across
> epub+pdf+cbz; the primary selected and showing progress; selecting another
> row updates the panel; Resume navigates; Download has the right href;
> offline save and then remove (reuse the `offline.e2e.ts` setup); copy name
> (clipboard permission granted); a book without files shows an empty state;
> no horizontal overflow at 390 px.

## Out of scope

Write-back, file upload/replace/delete (admin flows stay in the import pages),
re-extraction.

## Acceptance criteria

- [ ] Screenshot-6 structure (minus write-back) in app style.
- [ ] Offline save/remove works exactly as before, now from this tab.
- [ ] Progress is shown only on the file the saved progress points at.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/files/files.e2e.ts src/lib/sync/offline.e2e.ts
```

## Hand-off

Set this prompt to Done and update the BV7 row/log. Tell BV10 whether
`offline.e2e.ts` selectors moved.
