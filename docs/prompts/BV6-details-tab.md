# BV6: Details tab

- Status: Done
- Wave: 2. Dependencies merged: BV1, BV2, BV3, BV4
- Can run in parallel with: BV5, BV7, BV8, BV9
- Branch/worktree: `task/bv6` / `..\pandalibrary-bv6`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md): decisions 8 and 9, the
  `reading-summary` contract, the UI kit, the book context.
- The BV2, BV3 and BV4 hand-offs in [progress/README.md](../progress/README.md).
- `web/src/lib/bookview/tabs/DetailsTab.svelte` (currently the moved legacy page),
  `web/src/lib/bookview/**`, `web/src/lib/catalog/api.ts` (`listBooks` with
  `author_id`/`series_id`/`tag_id`), `web/src/lib/reader/api.ts`,
  `web/src/lib/reader/types.ts` (`Note`), `web/src/lib/stats/BarChart.svelte`.
- Screenshot 5. Left: a large cover, then Read (emerald) + eye, then download
  and library/shelf buttons. Middle: the title with a progress % pill, "by
  Author", stars, a status dropdown and "Personal Review"; format chip and
  provider link chips; tag chips; a **Synopsis** card with Show more and "Your
  review – Not written yet" with Write; a **Your reading** card (sessions,
  time, avg, progress, mini bar chart, the 3 latest sessions). Right: a
  **Details** list (publisher, published, language, pages, ISBN, file size,
  library, added, date started ✎, date finished ✎) and an **Editions** card.
  Bottom: **By Author / Similar Books** tabs with a horizontal cover carousel.

## Goal

Replace the legacy body in `DetailsTab.svelte` with the screenshot-5 layout in
the app style. Status, rating, dates and the personal review can be edited.
The admin edit link, provenance, identifiers and Add to shelf are kept.

## Scope

**Owns:** `web/src/lib/bookview/tabs/DetailsTab.svelte`,
`web/src/lib/bookview/details/**` (new: `DetailsHero.svelte`, `SynopsisCard.svelte`,
`ReviewEditor.svelte`, `ReadingCard.svelte`, `DetailsPanel.svelte`,
`EditionsCard.svelte`, `RelatedBooks.svelte`, `details-data.ts` + tests,
`details.e2e.ts`), `bv6.*` messages. Use BV2's `web/src/lib/bookview/log-api.ts`
for the summary and sessions. Do not edit it.

**Must not touch:** other tab files, the BV3 kit internals, backend.

## Subtasks

### BV6.1 – Data

> Create `details-data.ts`: `loadDetailsState(bookId, signal)` returns `{
> userBook, progress, review: Note | null, summary: ReadingSummary | null }`.
> It uses `getBookState` (the review is the newest live note with `highlight_id
> === null`) and `getReadingSummary` from `log-api.ts`.
> Offline, it uses the synced `readerState` and `summary = null`.
> `saveReview(bookId, existing, body)` pushes a `notes` upsert (a new UUIDv7
> when creating, the existing ID when editing; an empty body pushes a delete)
> and then `notifyBookStateChanged`. `loadRelated(book)` returns `{ byAuthor,
> similar }`: `byAuthor` is `listBooks({author_id: first author}, 'title',
> {limit: 24})` without the current book; `similar` is the same series first
> (by index), then the first tag's books, deduplicated, at most 24, without
> the current book. Unit-test these with mocked fetches.

### BV6.2 – Hero and left column

> In `DetailsTab.svelte`, build a 3-column grid on `xl` (`[18rem_1fr_20rem]`),
> 2 columns on `md` (the right panel goes below), and 1 column on mobile.
> Left: `BookCover size="lg"` (eager, badge) using `coverSource` from the
> context (keeps offline object URLs), then a row with **Read / Resume**
> (emerald, `read.ts`) and `ReadStatusMenu variant="icon"`, then a row with
> **Download** (a primary-file link; a format menu when there are multiple
> files; hidden offline) and **Add to shelf** (the BV5-style popover if merged,
> else the existing `AddToShelf` inline). The admin **Edit metadata** link
> stays (outline, pencil icon, hidden offline).

### BV6.3 – Middle column

> `DetailsHero.svelte`: the title (`text-3xl font-semibold`) plus the subtitle,
> a progress pill (`emerald-100`, `21%`) when progress > 0, "by" plus author
> links (with roles other than author shown muted), series with index,
> `RatingStars editable` (saves via `saveUserBook`),
> `ReadStatusMenu variant="pill"` (`reread = summary.attempts.length > 1`), and
> a "Personal review" link scrolling to the review. A row of format chips
> (all formats) plus `IdentifierLinks variant="chips"`. Tag chips (links).
> `SynopsisCard.svelte`: a "SYNOPSIS" caps label and the `ExpandableText`
> description (6 lines). A divider, then `ReviewEditor.svelte`: "YOUR REVIEW"
> plus the text or "Not written yet", and a **Write/Edit** button opening an
> inline textarea (max 10,000 characters, Save/Cancel, saving state, an error
> on `SyncError`). `ReadingCard.svelte` (hidden when the summary is null or has
> 0 sessions; shows a muted "No reading sessions yet" when 0): "YOUR READING",
> "last read {relative}", four stats (Sessions, Time, Avg, Progress), a 30-bar
> mini chart of the last 30 active days' seconds (CSS bars, emerald, `aria-hidden`
> plus a visually hidden summary), the 3 latest sessions from
> `listBookSessions(id, { limit: 3 })` (relative time, duration, reached %,
> source chip), and a link "Open reading log" to the Reading Log tab.

### BV6.4 – Right column, related books, preserved extras

> `DetailsPanel.svelte`: a "DETAILS" `<dl>` with label/value rows (publisher,
> published, language, pages, ISBN (from identifiers, else "–"), file size
> (primary), library name (from `getLibrary`; cached), added (`book.created_at`),
> date started and finished, each with a ✎ button opening an inline
> `<input type="date">` saved via `saveUserBook` with clear support).
> `EditionsCard.svelte`: one row per file (format chip, a progress bar when the
> saved progress points at that file, %, size), and "Files on disk N", linking
> to the Files tab. `RelatedBooks.svelte`: a segmented control "By author /
> Similar books", ‹ › scroll buttons, and a horizontal list of `BookCard`
> grids (w-36) with lazy loading and empty states. It is hidden when both are
> empty. Keep, below the right panel or at the bottom: **Identifiers** (as
> today) and **Provenance** (`<details>` as today). Remove the legacy body and
> the last use of `catalog.book.cover_unavailable` (delete the key from both
> message files if it is now unused).

### BV6.5 – Tests

> `details.e2e.ts` (mocked API): the layout renders all sections; a rating
> click pushes `user_books` with `rating`; status change; editing date started
> pushes `started_at`; Write review → Save pushes `notes`; the reading card
> shows the summary numbers; By author/Similar switch; admin sees Edit
> metadata, non-admin does not; offline mode (reuse the `offline.e2e.ts`
> helpers) shows the book without summary/download; 390 px has no horizontal
> overflow. Update `catalog.e2e.ts` and `offline.e2e.ts` selectors only where the
> markup changed.

## Out of scope

Files list actions (BV7), the session table (BV8), the highlights list (BV9).

## Acceptance criteria

- [x] The screenshot-5 structure in app style, responsive at 1440/1024/390 px.
- [x] All edits persist through `/sync/push` and survive a reload. The other
      open views refresh via `BOOK_STATE_CHANGED_EVENT`.
- [x] Every legacy feature is still reachable (decision 8).

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/details/details.e2e.ts src/routes/catalog.e2e.ts src/lib/sync/offline.e2e.ts
```

## Hand-off

Implemented on `task/bv6`. Offline Details shows synchronized state and the
cached cover, but reading-state and review edits are read-only; summary and
network download links are hidden. The legacy per-file read, download and
offline-storage controls and inline Add to shelf remain on Details until BV7
provides their replacements.

Validation: `pnpm check` (no diagnostics), 57 focused book-view unit tests, and
29 mocked Details, cover, shell, catalog and offline browser tests. The browser
tests used an isolated preview port.
