# BH3: Header Upload button and multi-file upload dialog

- Status: Done
- Wave: 1; dependencies merged: baseline `2566569`
- Can run in parallel with: BH1 (build against the plan contract with mocks)
- Migration: no
- Branch/worktree: `task/bh3` / `..\pandalibrary-bh3`

## Read first

- [Bookheap plan](../plans/bookheap-plan.md): decisions 4, 7 and 8, the
  `POST /api/v1/admin/bookheap/files` row and `HeapItem` DTO, the shared UX
  contract, and the `pandalibrary-bookheap-changed` event.
- `web/src/lib/shell/AppShell.svelte` (header layout, `viewer.role`),
  `AccountControls.svelte`, `web/src/lib/shelves/ShelfCreateDialog.svelte`
  (dialog focus trap/restore and Escape pattern to follow),
  `web/src/lib/api/client.ts` (`ApiError`, problem parsing),
  `web/src/lib/admin/api.ts` `uploadBook` (multipart contract precedent),
  `web/src/routes/admin/imports/+page.svelte` (existing single-file upload),
  `web/messages/{en,zh}.json`, `web/src/lib/shell/shell.e2e.ts`.

## Goal

Admins see an **Upload** button in the top header on every authenticated,
non-immersive page. It opens a modal where they drag and drop or select many
book files, review and edit the list, and upload them all into the Bookheap with
per-file progress and results. Uploading no longer requires the nested admin
page or choosing a library first.

## Scope

**Owns:**
- `web/src/lib/bookheap/UploadDialog.svelte` (new)
- `web/src/lib/bookheap/UploadButton.svelte` (new; header button + dialog host)
- `web/src/lib/bookheap/upload-queue.svelte.ts` (new; list/dedupe/queue state)
- `web/src/lib/bookheap/api.ts` (new; `uploadHeapFile` + shared `HeapItem`
  types; BH4 appends list/scan/delete/assign functions later)
- `web/src/lib/bookheap/types.ts`, `web/src/lib/bookheap/events.ts`
  (`BOOKHEAP_CHANGED_EVENT` constant + `notifyBookheapChanged()`)
- Unit tests next to these files; `web/src/lib/bookheap/upload.e2e.ts` (mocked)
- `bh3.*` keys in `web/messages/en.json` and `zh.json`

**Shared (localized edit):**
- `web/src/lib/shell/AppShell.svelte`: render `<UploadButton />` in the header
  next to the account controls, only when `viewer?.role === 'admin'` and the
  route is not immersive. Do not restyle or restructure the header.

**Must not touch:** backend, `nav.ts`/Sidebar (BH4), `/bookheap` routes (BH4),
the admin imports page.

## Requirements

1. **Header button.** Accessible button labeled "Upload" (icon + text; icon only
   on narrow screens, keeping the accessible name), `aria-haspopup="dialog"`.
   Hidden for non-admins and on immersive reader routes. Its style matches the
   existing header controls on the dark shell.
2. **Dialog.** A modal (`role="dialog"`, `aria-modal`, labeled title "Upload
   books"). It traps focus, restores focus to the trigger on close, closes on
   Escape and the close button, and does not close on outside click while
   files are listed. Its contents:
   - a **drop zone** that accepts drag-over/drop of files (with a visible
     highlight while dragging), described as "Drag and drop book files here".
     Dropped directories and non-file items are ignored with a notice;
   - a **Select files** button that opens a hidden `<input type="file"
     multiple>` whose `accept` lists `.epub,.pdf,.mobi,.azw3,.fb2,.fbz,.cbz`.
     Reset the input value after each pick so the same file can be chosen again;
   - a **Clear** button that removes every file from the list (disabled when
     the list is empty or while uploading);
   - the **file list**: name, human-readable size, status, and an **X** button
     per row (accessible name "Remove <file name>") that removes only that row.
     The list scrolls when long. An empty state explains what to do;
   - a footer with the summary (for example "3 files, 12.4 MB"), **Upload**
     (primary, disabled when there is nothing to upload) and **Close**.
3. **Adding files.** Both drop and Select append. A file whose
   `(name, size, lastModified)` already exists in the list is not added again,
   so selecting again only adds new files. Files with an unsupported extension
   or over the size limit are not added, and a dismissible notice lists them
   (the size limit is a constant for now; the server remains authoritative).
4. **Uploading.** Upload sends each pending file as its own
   `POST /api/v1/admin/bookheap/files` multipart request (single part `file`),
   two at a time, through `XMLHttpRequest` (so upload progress is available).
   Requests are same-origin with credentials, and errors are mapped to
   `ApiError`, matching `client.ts` problem parsing. Row statuses: `pending` →
   `uploading` (progress bar, percent) → `done` (title from the returned item)
   or `error` with a localized reason:
   - 409: "Already in your library" or "Already in Bookheap", using
     `duplicate_of_book_id` / `duplicate_of_item_id`;
   - 413: too large; 415: unsupported or damaged file;
   - 401/403: session/permission. Stop the queue and keep the list;
   - network/5xx: retryable.
   While uploading, Clear and per-row X are disabled for in-flight rows. X on a
   pending row still removes it. Selecting/dropping more files during an upload
   appends them as pending, and they are uploaded in the same run.
5. **After uploading.** Show a summary ("8 uploaded, 1 duplicate, 1 failed"),
   a **Retry failed** action, and a **View Bookheap** link to `/bookheap` (BH4
   creates the route; the link simply navigates). Successful rows can be
   cleared with Clear. Dispatch `pandalibrary-bookheap-changed` once per run
   that uploaded at least one file.
6. **Closing during upload.** Ask for confirmation. Confirming aborts in-flight
   requests and leaves unstarted files unsent. Already-uploaded files remain in
   the heap. Reopening the dialog after a normal close keeps the remaining
   (non-done) rows until the page is reloaded; done rows are dropped.
7. **Accessibility/i18n.** Every label, status, notice and error uses `bh3.*`
   messages in English and Chinese. Progress uses `role="progressbar"` with
   values. Status changes are announced politely (`aria-live`). Everything works
   with the keyboard: the drop zone is not the only way to add files.

## Out of scope

- The `/bookheap` page, nav item, scanning and assignment (BH4).
- Real-server verification (BH5). Resumable/chunked uploads; folder uploads.

## Acceptance criteria

- [x] Unit tests for the queue: dedupe on reselect/drop, unsupported/oversize
      filtering, remove one, clear all, concurrency limit 2, status
      transitions, 409/413/415/401/network mapping, retry failed, abort on
      confirmed close, single change event per run.
- [x] Mocked browser test (`page.route`): admin sees the header button and a
      non-admin does not. Drag-drop and Select build the list; X removes one;
      Clear empties; Upload shows progress and mixed results; focus returns to
      the trigger; Escape closes.
- [x] `pnpm --dir web check`, `pnpm --dir web test`, `pnpm --dir web build` pass;
      existing shell browser tests still pass.

## Validation commands

```powershell
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web test:e2e -- src/lib/bookheap/upload.e2e.ts src/lib/shell/shell.e2e.ts
```

## Hand-off

Record the exported component props (`UploadDialog`: `open`, `onclose`), the
`api.ts`/`events.ts` exports BH4 must reuse, and test results here. Update your
progress row and append a dated log.

### Implemented 2026-11-06

**Components** (`web/src/lib/bookheap/`):

- `UploadButton.svelte` (no props): the header trigger plus its dialog host.
  `AppShell.svelte` renders it only when `viewer?.role === 'admin'` and the
  route is not immersive. Text label from `sm` up, icon only below, the
  accessible name is always "Upload"; focus returns to it after close.
- `UploadDialog.svelte` props: `open: boolean`, `onclose: () => void`, and an
  optional `queue?: UploadQueue` (defaults to the shared `uploadQueue`). BH4
  should render `<UploadDialog {open} onclose={...} />` from its toolbar
  without a `queue` prop so the header and page share one list. The dialog
  restores focus to whatever was focused when it opened. It is a native modal
  `<dialog>` (`aria-labelledby` title "Upload books"), with an explicit Tab
  trap; Escape and both Close buttons close it; it never closes on backdrop
  click. While a run is active, closing asks for confirmation; confirming
  aborts in-flight requests, unstarted rows stay pending, and closing drops
  only `done` rows.

**Modules BH4 must reuse (do not change these exports):**

- `api.ts`: `uploadHeapFile(file, { signal?, onprogress?, createRequest? })
  → Promise<HeapItem>`, `BOOKHEAP_FILES_PATH`, `apiErrorFromResponse(status,
  statusText, contentType, body)` (mirrors `client.ts` problem parsing for
  non-fetch responses) and the `UploadRequest` test seam. Append list, scan,
  delete and assign functions after these.
- `types.ts`: `HeapItem`, `HeapItemStatus`, `HeapItemSource` from the plan DTO.
- `events.ts`: `BOOKHEAP_CHANGED_EVENT` (`'pandalibrary-bookheap-changed'`)
  and `notifyBookheapChanged(target = window)`. The queue dispatches it once
  per run that uploaded at least one file (including an aborted run).
- `upload-queue.svelte.ts`: `uploadQueue` (shared instance), `UploadQueue`,
  `SUPPORTED_EXTENSIONS`, `UPLOAD_ACCEPT`, `MAX_UPLOAD_BYTES` (1 GiB, the
  server's default `--max-upload-mb`), `UPLOAD_CONCURRENCY` (2), `formatBytes`,
  `classifyUploadError`, `filesFromDataTransfer`, `uploadPercent`.

**Behavior notes:**

- Error kinds: 409 → `duplicate_book` (links to `/books/{id}` when idle) /
  `duplicate_item` / `duplicate`; 413 `too_large`; 415 `unsupported`;
  400 `invalid`; 401 `unauthorized` / 403 `forbidden` halt the queue and show
  a banner while other pending rows stay; 5xx `server`; fetch-style
  `TypeError` `network`; anything else `unknown`. **Retry failed** re-queues
  only `network`, `server`, `unknown`, `unauthorized` and `forbidden` rows;
  duplicates, too-large, unsupported and invalid rows are final.
- Drops ignore directories (`webkitGetAsEntry().isFile === false`). String
  items (links/text) are ignored silently when files are present, because OS
  file managers add them, and reported in the notice only when a drop contains
  no files.
- The Upload button uses `aria-disabled` rather than `disabled` so keyboard
  focus is not lost when a run starts; Clear and Retry move focus to a stable
  control.

**Tests:** `upload-queue.test.ts` (12) and `api.test.ts` (5), all queue
acceptance cases plus the XHR contract. `upload.e2e.ts` (4, mocked with
`page.route`) covers admin and non-admin visibility, reader routes, the
narrow icon-only button, drop/Select/dedupe/notice/remove/Clear, held uploads
with two progress bars, mixed 201/409/409/503 results, Retry failed, one change
event, Escape and focus return, and confirmed abort with rows kept. Not yet
verified against BH1's real endpoint (BH5).
