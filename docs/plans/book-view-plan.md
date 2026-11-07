# Book View (BV): generated covers, quick view drawer, tabbed book details

Status: Done (BV1-BV10 merged; see [book-view.md](../architecture/book-view.md)). Requested 2026-11-07.
Baseline: `72c469c` (`master`). Local issue specifications only; nothing is
published to GitHub.

## Request (as given)

1. When a cover is unavailable (today a grey "Cover unavailable" box on the
   dashboard rows and the All Books grid), show a **default cover with the book
   name on it**; truncate a long name.
2. Show the **book format** badge in the cover's top-left corner (PDF, EPUB, ...).
3. Hovering a cover shows **two icons**. The **info** icon opens a **right-side
   flyout drawer** with a quick view (cover, title, external links, authors,
   rating, format/pages/date/language chips, publisher, primary file, tags,
   collections, synopsis with "Show more", footer Read / Details / status /
   add-to-shelf). Adapt it to the app's style.
4. **Details** opens a tabbed details page: **Details** (hero cover, rating,
   status, chips, synopsis + your review, your reading summary, details panel,
   editions, by-author / similar carousel), **Files** (summary, files grouped
   by reader, "this file" panel), **Reading Log** (summary, sessions table,
   attempts, records, progress-over-time chart), **Highlights** (search/filter
   list grouped by chapter, statistics sidebar).

## Assessment of the current code

- `web/src/lib/catalog/BookCard.svelte` (grid + list) is used by
  `BookBrowser` (All Books, library/author/series/tag pages), dashboard rows
  and both shelf pages. `SearchResultCard.svelte` and
  `routes/books/[id]/+page.svelte` draw their own "Cover unavailable" box.
  There is no image-error fallback.
- `Book.files[]` (`id`, `format`, `size_bytes`, `download_url`) is already in
  list responses, so the format badge needs no API change. `SearchResult` has
  no files, so search covers get no badge.
- Per-user data that exists: `user_books` (status `unread|want_to_read|
  reading|finished|abandoned`, rating 1-10 = half stars, `started_at`,
  `finished_at`, LWW via `/sync/push`), `reading_progress` (one row per book,
  with `book_file_id`), `highlights` (`color`, `chapter`, `position`, `text`),
  `notes` (book-level when `highlight_id` is null), `bookmarks`, and append-only
  `reading_sessions` (pushed, **never pulled** by clients). `GET
  /api/v1/me/books/{id}` returns user_book, progress, highlights, bookmarks and
  notes. Notes export already accepts `book_ids`.
- Missing for the new UI: a per-book session history and summary, deleting a
  session, which shelves contain a book, and `original_filename`/`created_at`
  on `BookFile`. None needs a migration.
- `/books/[id]` is a single page holding details, files (read/download/offline
  save/remove), Add to shelf, identifiers, provenance and the admin
  **Edit metadata** link. `/books/[id]/edit` is a separate admin page. The
  reader accepts `?bookmark=<id>` to jump to a saved position.
- No icon library is installed. Dialog conventions live in
  `ShelfCreateDialog.svelte` / BH dialogs. Cross-component refresh uses
  `window` events (`pandalibrary-shelves-changed`, `pandalibrary-bookheap-changed`).

## Product decisions used by these prompts

Change them here and in the affected prompts before launching a wave.

1. **Generated cover is client-side.** No server image. `BookCover.svelte`
   renders a styled block: deterministic muted background chosen from 8 app
   tones by hashing `book.id`, a thin spine shade on the left, the title
   (CSS line-clamp: 5 lines on md/lg, 3 on sm; plus a hard cap of 80 graphemes
   via `Intl.Segmenter` with "…"), and the first author on one line. Text scales
   with the cover (container query units). It is also used when a real cover
   fails to load (`onerror`). It has `role="img"` and an accessible name of the
   title.
2. **Format badge.** One pill in the top-left corner for the preferred format.
   Order: epub, pdf, cbz, azw3, mobi, fb2, fbz. When the book has several
   formats, the pill reads `EPUB +1` and its tooltip/accessible text lists all.
   No pill when the book has no files. Tones: EPUB emerald, PDF red, CBZ
   amber, AZW3/MOBI sky, FB2/FBZ violet.
3. **Hover actions.** On devices that can hover (`@media (hover: hover)`),
   hovering or focusing within the cover dims it and shows two round icon
   buttons: **Info** (opens the quick view) and **Read** (resumes the saved
   file, otherwise opens the first readable format; hidden when no file is
   readable). On touch devices, a small persistent Info button sits in the
   bottom-right corner and tapping the cover follows the title link. Both
   buttons are keyboard-reachable and have accessible names. Search results get
   the generated cover and Info only.
4. **Quick view drawer.** Right-side drawer: 28rem wide on desktop, full width
   below `sm`. It is opened by the `pandalibrary-quick-view` window event and
   hosted once in `AppShell`. It uses a dimmed backdrop, traps focus, closes on
   Escape, the X button, a backdrop click or route navigation, and restores
   focus to the trigger. The app style is white/slate surfaces, emerald
   primary, `rounded-2xl` sections and slate chips. "Collections" means the
   viewer's manual shelves containing the book. Footer: **Read** (primary),
   **Details** (secondary, goes to `/books/{id}`), **Reading status** (eye icon
   menu) and **Add to shelf** (folder-plus popover).
5. **External links** from identifiers: `isbn`/`isbn13`/`isbn10` → Open
   Library, Google Books, Goodreads search and Amazon search; `google` → Google
   Books volume; `goodreads` → Goodreads book; `amazon`/`asin` → Amazon `dp`;
   `openlibrary` → Open Library. All links use
   `target="_blank" rel="noopener noreferrer"`, and values are URL-encoded.
   Other schemes are shown as plain text chips.
6. **Routes.** The tabbed pages live in a route group so the edit page stays
   outside the tab layout:
   `routes/books/[id]/(tabs)/+layout.svelte`, `(tabs)/+page.svelte` (Details),
   `(tabs)/files`, `(tabs)/reading-log`, `(tabs)/highlights`. The URLs are
   `/books/{id}`, `/books/{id}/files`, `/books/{id}/reading-log` and
   `/books/{id}/highlights`. `/books/{id}/edit` is unchanged.
7. **Tab bar.** It shows **‹ Books** (history back when the previous entry is
   in-app, else `/books`), the four tabs as links with `aria-current="page"`,
   and, on the right, **`i / n` ‹ ›** taken from the browse context saved by the
   originating list (sessionStorage, at most 5,000 IDs). That part is hidden
   when the page was opened directly.
8. **Nothing is lost.** Every feature of today's book page survives: read per
   format, download, offline save/remove (moved to Files), Add to shelf,
   identifiers, provenance (collapsible on Details), the admin Edit metadata
   link, and offline loading of the book from IndexedDB.
9. **Editable user state** (all through the existing `/sync/push`, LWW):
   status, rating (half stars), started/finished dates (`user_books`), and the
   "Your review" text (the newest live book-level note). There is no
   "re-reading" status. The status label reads **Re-reading** when the status
   is `reading` and the BV2 summary reports more than one attempt.
10. **Reading sessions.** "Add session" pushes a `reading_sessions` upsert
    (UUIDv7, `source: "web"`, `device: "Manual entry"`). Deleting a session uses a
    new owner-only endpoint. This is safe because sessions are never pulled to
    clients. `/api/v1/stats` reflects the deletion.
11. **Attempts are derived, not stored.** Sessions are ordered by `started_at`.
    A new attempt starts at a session whose start position (end position when
    the start is null) is ≤ 10% after the current attempt has reached ≥ 95%, or
    at the first session that starts after `user_books.finished_at` when the
    current attempt began before it. An attempt is `completed` when it reached
    ≥ 95% or contains `finished_at`. Otherwise the last attempt is `in_progress`
    and earlier ones are `stopped`.
12. **Highlights tab is read-mostly.** Search, filter (color, notes only),
    sort (reading order / newest), compact toggle, export (E1, this book) and
    jump to the reader (`?highlight=<id>`, added the same way as
    `?bookmark=`). Editing and deleting highlights stays in the reader.
13. **Out of scope:** write-back, cover-strip reading-progress bars on list
    cards (lists carry no per-user progress), a stored "re-reading" status, and
    automatic-shelf membership in "Collections".

## Shared API contract (BV1, BV2; JSON, timestamps RFC3339 UTC)

All are authenticated. Mutations are cookie-protected. Book visibility
follows the existing catalog rules: an invisible book is `404`.

| Method | Path | Owner | Behavior |
|---|---|---|---|
| GET | `/api/v1/books`, `/api/v1/books/{id}` (changed) | BV1 | each `files[]` item gains `original_filename` (base name, never a directory path; control characters become `_`; `<title>.<format>` when empty) and `created_at` |
| GET | `/api/v1/books/{id}/shelves` | BV1 | `{shelves: Shelf[]}` – the viewer-visible **manual** shelves (custom manual + Favorites) containing the book, by name (case-insensitive) then ID, at most 200; same `Shelf` DTO as `/api/v1/shelves` |
| GET | `/api/v1/me/books/{id}/reading-summary?timezone=<IANA>` | BV2 | `{summary}` (below); `400` for a bad timezone |
| GET | `/api/v1/me/books/{id}/sessions?range=all\|30d\|90d\|year&timezone=&limit=&cursor=` | BV2 | `{items: Session[], next_cursor, total}`; newest first; limit 1-100 (default 25); opaque filter-bound cursor; `year` = current calendar year in `timezone` |
| DELETE | `/api/v1/me/books/{id}/sessions/{sessionId}` | BV2 | `204`; `404` when it is missing, not the viewer's own, or the book is invisible |

```json
{
  "summary": {
    "progress": 0.21,
    "sessions": 196,
    "total_seconds": 10560,
    "average_seconds": 54,
    "active_days": 108,
    "span_days": 170,
    "first_read_at": "2026-05-21T10:00:00Z",
    "last_read_at": "2026-11-06T06:14:00Z",
    "pace_percent_per_hour": 14.2,
    "estimated_seconds_left": 300,
    "records": {
      "longest_session": { "seconds": 360, "date": "2026-06-26" },
      "best_day": { "seconds": 600, "date": "2026-07-01" },
      "longest_streak_days": 9
    },
    "attempts": [
      { "number": 7, "status": "in_progress", "started_at": "...", "ended_at": "...",
        "sessions": 18, "seconds": 660, "max_percentage": 0.25, "sources": ["web"] }
    ],
    "days": [ { "date": "2026-05-21", "seconds": 120, "sessions": 2, "max_percentage": 0.96 } ]
  }
}
```

`Session`: `{id, source, device, started_at, ended_at, active_seconds,
start_percentage, end_percentage, change, attempt}`. `change` is
`end - start` when both are known, otherwise `null`. `progress` is
`reading_progress.percentage` (0 when there is none). Pace is
`Σ max(0, end-start) × 100 / total hours` (null without data). The estimate
is `(1-progress)×100 / pace × 3600` (null when pace is null or 0). `days` are
active days in `timezone`, ascending, with at most 3,660 entries. `attempts`
are newest first. Without sessions, the counts are 0 and the arrays empty.

BV2 implementation clarifications (for BV6/BV8):

- `timezone` defaults to `UTC` when omitted; an empty or unknown value is 400.
- A day is active when it has more than 0 seconds (as in ST1 streaks); `days`
  lists only active days. `active_days`, `span_days`, and the streak use all
  of them, even beyond the 3,660-entry cap.
- Both pace sums use only sessions with both percentages known; pace is null
  when those sessions total 0 seconds. `progress` is clamped to 0..1.
- `longest_session` and `best_day` are null without positive-second data;
  ties keep the earliest. `first_read_at` is the earliest start and
  `last_read_at` the latest end.
- `range` bounds are local midnight of today−29 (`30d`) or today−89 (`90d`)
  in `timezone`. The cursor carries that bound, so later pages stay stable
  across midnight.
- Under decision 11, every non-final attempt is `completed`: a restart either
  follows ≥95% or crosses `finished_at`. `stopped` stays in the enum but is
  currently unreachable.
- `deleteBookSession` tolerates the 204 without changing the shared API client.
  `addManualSession` pushes a `source: 'web'` session through `pushMutation`
  (device `Manual entry`) and resolves to the new session ID.

## Shared frontend contract

- **Events** (`web/src/lib/bookview/events.ts`, created by BV3):
  - `QUICK_VIEW_EVENT = 'pandalibrary-quick-view'` with detail
    `{ bookId: number; book?: Book }`, plus `openQuickView(detail)`. The opener
    records `document.activeElement` as the trigger for focus restore.
  - `BOOK_STATE_CHANGED_EVENT = 'pandalibrary-book-state-changed'` with detail
    `{ bookId: number }`, plus `notifyBookStateChanged(bookId)`. Every
    status/rating/date/review/session change dispatches it. Open views reload.
- **UI kit** (`web/src/lib/bookview/`, created by BV3; later tasks import it
  and must not fork it): `BookCover`, `FormatBadge`, `CoverActions`,
  `RatingStars`, `ExpandableText`, `IdentifierLinks`, `ReadStatusMenu`, `Icon`,
  `cover.ts`, `format.ts` (size, duration, percent, relative time),
  `user-book.ts` (`saveUserBook`), `read.ts` (`readTarget(book, account)`).
- **Typed API clients** ship with their API task: BV1 adds the `BookFile`
  fields and `getBookShelves` to `web/src/lib/catalog/`. BV2 adds
  `web/src/lib/bookview/log-api.ts` (`getReadingSummary`, `listBookSessions`,
  `deleteBookSession`, `addManualSession`, `viewerTimezone`).
- **Browse context** (`web/src/lib/bookview/browse-context.ts`, BV4):
  `rememberBrowseContext({ ids, label, href })` and
  `browseNeighbors(bookId) -> { index, total, previousId, nextId, label, href } | null`.
- **Book context** (`web/src/lib/bookview/book-context.svelte.ts`, BV4): the tab
  layout loads the book once (online or offline) and exposes
  `getBookContext() -> { book, offline, coverSource, canEditMetadata, reload() }`.
  The tabs never refetch the book themselves.
- **Tab component slots** (BV4 creates placeholders; each tab task then owns
  its file): `web/src/lib/bookview/tabs/DetailsTab.svelte` (BV6),
  `FilesTab.svelte` (BV7), `ReadingLogTab.svelte` (BV8),
  `HighlightsTab.svelte` (BV9). Route files only render these.

## Tasks and parallel execution

| Wave | Task | Goal | Dependencies | Migration | Prompt |
|---|---|---|---|---|---|
| 1 | BV1 | Catalog API: file name/added date, shelves containing a book | baseline | No | [BV1](../prompts/BV1-catalog-detail-api.md) |
| 1 | BV2 | Per-book reading log API: summary, sessions page, delete | baseline | No | [BV2](../prompts/BV2-reading-log-api.md) |
| 1 | BV3 | Cover kit: generated cover, format badge, hover actions, shared primitives | baseline | No | [BV3](../prompts/BV3-cover-kit.md) |
| 1 | BV4 | Details page shell: route group, tab bar, book context, browse prev/next | baseline | No | [BV4](../prompts/BV4-details-shell.md) |
| 2 | BV5 | Quick view drawer | BV1, BV3 | No | [BV5](../prompts/BV5-quick-view.md) |
| 2 | BV6 | Details tab | BV1, BV2, BV3, BV4 | No | [BV6](../prompts/BV6-details-tab.md) |
| 2 | BV7 | Files tab | BV1, BV3, BV4 | No | [BV7](../prompts/BV7-files-tab.md) |
| 2 | BV8 | Reading Log tab | BV2, BV3, BV4 | No | [BV8](../prompts/BV8-reading-log-tab.md) |
| 2 | BV9 | Highlights tab (+ reader `?highlight=`) | BV3, BV4 | No | [BV9](../prompts/BV9-highlights-tab.md) |
| 3 | BV10 | Integration, real-server E2E, visual QA, docs, **full verification** | BV1-BV9 | No | [BV10](../prompts/BV10-integration.md) |

```text
Wave 1 (4 parallel):  BV1 catalog API || BV2 reading-log API || BV3 cover kit || BV4 details shell
                            \               |                  |                 /
Wave 2 (5 parallel):  BV5 quick view || BV6 Details || BV7 Files || BV8 Reading Log || BV9 Highlights
                                                   \     |     /
Wave 3 (alone):                              BV10 integration + full verification
```

- Wave 1 has no cross-dependencies. BV3 and BV4 need no new API.
- Wave 2 uses the merged wave-1 code directly, so no mocks are needed for BV1/BV2.
- **Verification policy:** wave 1 and wave 2 sessions run only the *targeted*
  checks listed in their prompt (the touched Go packages, `pnpm check`, the
  vitest files and the one mocked Playwright spec they add). The full gate
  (`task sqlc:check lint test build`, `pnpm --dir web check test build`, the full
  real-server `test:e2e`, and a visual review) runs **once** in BV10 after all
  tasks are merged.

Worktrees for wave 1:

```powershell
git worktree add ..\pandalibrary-bv1 -b task/bv1 master
git worktree add ..\pandalibrary-bv2 -b task/bv2 master
git worktree add ..\pandalibrary-bv3 -b task/bv3 master
git worktree add ..\pandalibrary-bv4 -b task/bv4 master
```

In each session: `Implement docs/prompts/BV1-catalog-detail-api.md`
(substitute its own prompt). Each prompt is split into subtasks (BVn.m), each
with its own prompt section. Do them in order inside one session, committing
after each subtask.

## Ownership and merge protocol

Each prompt's Scope section is authoritative.

- BV1: `internal/catalog/**` (file DTO, book-shelves query), the catalog SQL
  queries + regenerated sqlc output for them, `internal/httpapi/catalog.go` /
  `shelves.go` routes and tests, and the matching web client
  (`BookFile` fields in `web/src/lib/catalog/types.ts`, `getBookShelves` in
  `web/src/lib/catalog/api.ts`).
- BV2: `internal/reading/booklog*.go` (new), its SQL in
  `internal/db/queries/reading.sql` (append), regenerated sqlc output, the
  routes in `internal/httpapi/reading.go`, and the web client
  `web/src/lib/bookview/log-api.ts` (summary, sessions, delete, manual add).
- BV3: `web/src/lib/bookview/**` except `log-api.ts`, `browse-context.ts`,
  `book-context.svelte.ts` and `tabs/**`. It also edits
  `catalog/BookCard.svelte` and `search/SearchResultCard.svelte`, and widens
  the existing `reader/api.ts` mutation entity type to include the already
  supported `user_books` upsert.
- BV4: `routes/books/[id]/(tabs)/**`, removal of the old
  `routes/books/[id]/+page.svelte`, `bookview/browse-context.ts`,
  `bookview/book-context.svelte.ts`, placeholder `bookview/tabs/*.svelte`, and
  one-line `rememberBrowseContext` calls in `BookBrowser.svelte` and both shelf
  pages.
- BV5: `bookview/quickview/**` and the host line in `shell/AppShell.svelte`.
- BV6/BV7/BV8/BV9 each own only their tab file plus a same-named folder
  (`bookview/details/**`, `files/**`, `log/**`, `highlights/**`). BV9 also gets
  the narrow `?highlight=` edit in the reader route.
- Messages: only `bv3.*`…`bv10.*` keys in `web/messages/en.json` and `zh.json`.
  Merge by key union. Never edit generated Paraglide output.
- Go tasks register routes in their own handler files. If `routes.go` needs a
  mount, append one line.
- No new dependencies (icons are inline SVG). No ACL relaxations, and no
  client-only authorization.
- Each session edits only its own progress row and prompt status, and appends
  one dated log entry.

## Shared UX contract

Same as the earlier batches: typed API client and `ApiError`, problem
responses, English and Chinese copy, accessible names for icon buttons, focus
trap/restore and Escape for overlays, explicit loading/empty/error/retry
states, stale-response suppression, visible focus rings (emerald), responsive
layout down to 360 px, and `prefers-reduced-motion` respected for drawer and
hover transitions.
