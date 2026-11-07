# Book View — architecture

Status: implemented (BV1–BV10, see [the plan](../plans/book-view-plan.md)).
This document describes how the book detail pages, the quick view drawer and
the generated covers fit together. The system overview is in
[system.md](./system.md); the API conventions are in its §5.

## 1. Routes and tab layout

The tabbed pages live in a SvelteKit route group so the admin edit page stays
outside the tab layout:

| URL | Route file | Tab component |
|---|---|---|
| `/books/{id}` | `routes/books/[id]/(tabs)/+page.svelte` | `bookview/tabs/DetailsTab.svelte` |
| `/books/{id}/files` | `(tabs)/files/+page.svelte` | `bookview/tabs/FilesTab.svelte` |
| `/books/{id}/reading-log` | `(tabs)/reading-log/+page.svelte` | `bookview/tabs/ReadingLogTab.svelte` |
| `/books/{id}/highlights` | `(tabs)/highlights/+page.svelte` | `bookview/tabs/HighlightsTab.svelte` |
| `/books/{id}/edit` | `routes/books/[id]/edit/+page.svelte` | admin metadata editor (unchanged) |

- `(tabs)/+layout.svelte` creates the book context, renders `BookTabs` and the
  loading/error/not-found states, and renders the active tab. Route files only
  render their tab component.
- `BookTabs.svelte` shows **‹ Books** (history back when the previous entry is
  in-app, else the browse-context `href` or `/books`), the four tabs as links
  with `aria-current="page"` (switching tabs replaces the history entry and
  keeps scroll), and the **`i / n` ‹ ›** browse control. `[` and `]` move to
  the previous/next book outside text inputs. The tab strip scrolls
  horizontally on narrow screens and keeps the active tab in view.
- The reader accepts `?bookmark=<id>` and `?highlight=<id>` to jump to a saved
  position; the Highlights tab links to `/read/{bookId}/{fileId}?highlight=<id>`.

## 2. Book and browse contexts

- **Book context** (`bookview/book-context.svelte.ts`). The layout loads the
  book once and exposes `getBookContext() → { book, offline, coverSource,
  canEditMetadata, reload() }`. Online it fetches `/api/v1/books/{id}`; when
  offline (or the request fails with a network error) it falls back to the
  IndexedDB copy from `#lib/sync/library.js` and loads the cached cover. The
  tabs never refetch the book themselves; they call `reload()` after a change.
- **Browse context** (`bookview/browse-context.ts`). Lists that open books
  (`BookBrowser` — All Books, library/author/series/tag pages — and both shelf
  pages) call `rememberBrowseContext({ ids, label, href })`, stored in
  `sessionStorage` (at most 5,000 IDs). `browseNeighbors(bookId)` returns
  `{ index, total, previousId, nextId, label, href }` or `null`; the browse
  control is hidden when the page was opened directly.

## 3. Events

Defined in `bookview/events.ts`; both are `window` `CustomEvent`s.

| Event | Detail | Producer | Consumers |
|---|---|---|---|
| `pandalibrary-quick-view` (`QUICK_VIEW_EVENT`) | `{ bookId, book?, trigger }` | `openQuickView()` from cover Info buttons; records `document.activeElement` as `trigger` | `QuickViewHost` (mounted once in `AppShell`) |
| `pandalibrary-book-state-changed` (`BOOK_STATE_CHANGED_EVENT`) | `{ bookId }` | `notifyBookStateChanged()` after every status, rating, date, review or session change | open drawer, all tabs, dashboard rows; each reloads only for its own `bookId` |

Shelf membership changes keep using the existing
`pandalibrary-shelves-changed` event.

## 4. UI kit inventory (`web/src/lib/bookview/`)

Later features import these and must not fork them.

| Module | Purpose |
|---|---|
| `BookCover.svelte` | Real cover with `onerror` fallback to the generated cover; `role="img"` named by the title |
| `FormatBadge.svelte` | Top-left format pill (`EPUB +1`, tooltip lists all formats) |
| `CoverActions.svelte` | Hover/focus Info + Read buttons; persistent Info button on touch devices |
| `RatingStars.svelte`, `rating.ts` | Half-star rating display/editor (1–10 scale) |
| `ReadStatusMenu.svelte`, `StatusIcon.svelte` | Localized eight-status menu and reusable status icons; **Re-reading** is an explicit stored status, independent of attempt history |
| `ProgressRing.svelte` | Circular progress used by Details and the Reading Log |
| `ExpandableText.svelte` | Clamp with "Show more" |
| `IdentifierLinks.svelte`, `identifiers.ts` | External links from identifiers (§ plan decision 5) |
| `Icon.svelte` | Inline SVG icons (no icon dependency) |
| `cover.ts` | Tones, title truncation, format ordering and tones |
| `format.ts` | Size, duration, percent, date and relative-time formatting helpers |
| `user-book.ts` | Status labels/tones and `saveUserBook` — `user_books` upsert through `/sync/push` (LWW) |
| `read.ts` | `readTarget(book, account)` — resume the saved file or the first readable format |
| `log-api.ts` | Typed reading-log client (`getReadingSummary`, `listBookSessions`, `deleteBookSession`, `addManualSession`, `viewerTimezone`) |

Feature folders: `quickview/` (drawer), `details/`, `files/`, `log/`,
`highlights/` (one per tab).

## 5. Cover generation rules

Covers are generated client-side; there is no server image.

- Shown when the book has no cover or the real cover fails to load.
- Background tone: one of 8 muted tones (emerald, teal, sky, indigo, violet,
  rose, amber, slate) chosen by an integer hash of `book.id`, so a book always
  gets the same tone. A darker spine shade sits on the left edge.
- Title: hard cap of 80 graphemes (`Intl.Segmenter`, ending in "…"), then a
  CSS line clamp. The first author is shown on one line. Text scales with the
  cover via container query units.
- Format badge: the preferred format in the order epub, pdf, cbz, azw3, mobi,
  fb2, fbz (unknown formats sort last alphabetically); `+N` when there are
  more. Tones: EPUB emerald, PDF red, CBZ amber, AZW3/MOBI sky, FB2/FBZ violet.
  No badge without files. Search results get the generated cover and Info only
  (they carry no files).
- Card titles under the cover are clamped (3 lines in the grid, 2 in the list)
  and carry the full title as a tooltip.

## 6. Attempt derivation

Attempts are derived on the server (`internal/reading/booklog*.go`), never
stored:

1. Sessions are ordered by `started_at`.
2. A new attempt starts at a session whose start position (end position when
   the start is null) is ≤ 10% after the current attempt reached ≥ 95%, or at
   the first session that starts after `user_books.finished_at` when the
   current attempt began before it.
3. An attempt is `completed` when it reached ≥ 95% or contains `finished_at`.
   Otherwise the last attempt is `in_progress`; earlier ones would be
   `stopped`, but under these rules every non-final attempt is `completed`, so
   `stopped` is currently unreachable.

Attempts are returned newest first; each session carries its attempt number,
and the sessions table shows an "Attempt N began" divider.

## 7. API endpoints

All are authenticated; mutations are cookie-protected and follow the catalog
visibility rules (an invisible book is `404`).

| Method | Path | Used by |
|---|---|---|
| GET | `/api/v1/books/{id}` (files gain `original_filename`, `created_at`) | book context, drawer |
| GET | `/api/v1/books/{id}/shelves` | drawer "Collections", Details shelves |
| GET | `/api/v1/me/books/{id}` | user book, progress, highlights, notes |
| GET | `/api/v1/me/books/{id}/reading-summary?timezone=` | Details "Your reading", Reading Log, status label |
| GET | `/api/v1/me/books/{id}/sessions?range=&timezone=&limit=&cursor=` | Reading Log sessions table |
| DELETE | `/api/v1/me/books/{id}/sessions/{sessionId}` | Reading Log delete |
| POST | `/api/v1/sync/push` | status, rating, dates, review note, manual session |
| GET | `/api/v1/me/notes/export?book_ids={id}` | Highlights export |
| GET | `/api/v1/books/{id}/files/{fileId}` (`download_url`) | Read, download, offline save |

The response shapes are in [system.md §5 "Reading log contract
(BV2)"](./system.md#reading-log-contract-bv2) and the
[plan](../plans/book-view-plan.md#shared-api-contract-bv1-bv2-json-timestamps-rfc3339-utc).

## 8. Offline behaviour

| Surface | Offline behaviour |
|---|---|
| Book context | Falls back to the IndexedDB copy of a downloaded book; otherwise shows the not-available-offline state |
| Quick view drawer | Uses the cached book; hides Collections and the admin Edit metadata link |
| Details | Read-only notice; editing of status, rating, dates and review is disabled; the reading summary and shelf sections are not loaded |
| Files | Lists cached files; reading saved copies works; download, save and remove actions that need the server are disabled |
| Reading Log | Shows "Reading log needs a connection" with a retry that reloads once back online |
| Highlights | Reads highlights and notes from the local reader state; export is disabled |

Changes made offline in the reader (progress, highlights, sessions) still go
through the outbox and appear in these views after syncing.

## 9. Tests

- Unit (vitest): cover helpers, browse/book contexts, view models for each tab.
- Mocked Playwright: `covers`, `quickview`, `details-shell`, `details`,
  `files`, `log`, `highlights` specs under `web/src/lib/bookview/**`.
- Real server: `web/src/routes/bookview-real.e2e.ts` seeds books through the
  API and walks catalog → drawer → every tab → reader, then checks that the
  reading summary and sessions survive a server restart.
