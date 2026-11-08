# Book View — architecture

Status: implemented (BV1–BV10, BC1–BC8 and BD1–BD8; see the
[book view plan](../plans/book-view-plan.md) and
[book cover plan](../plans/book-cover-plan.md), and
[book detail plan](../plans/book-detail-plan.md)).
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
| `/books/{id}/activities` | `(tabs)/activities/+page.svelte` | `bookview/tabs/ReadingLogTab.svelte` |
| `/books/{id}/reading-log` | `(tabs)/reading-log/+page.ts` | legacy redirect to Activities, preserving the query |
| `/books/{id}/highlights` | `(tabs)/highlights/+page.svelte` | `bookview/tabs/HighlightsTab.svelte` |
| `/books/{id}/edit` | `routes/books/[id]/edit/+page.svelte` | admin metadata editor (unchanged) |

- `(tabs)/+layout.svelte` creates the book context, renders `BookTabs` and the
  loading/error/not-found states, and renders the active tab. Route files only
  render their tab component.
- `BookTabs.svelte` shows a 36 px **back icon** with an accessible
  "Back to {label}" name. It returns to the stored origin (pathname and
  query), falling back to Dashboard (`/`) for a fresh deep link. History back
  is used only on a direct arrival from that origin; otherwise navigation
  targets the origin explicitly. Reader and metadata-editor round trips,
  tabs and book-to-book moves preserve the origin. The four tabs are links
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
  `sessionStorage` (at most 5,000 IDs). Dashboard tile activation remembers
  only the activated row, not whichever row loaded last.
  `browseNeighbors(bookId, originHref)` returns
  `{ index, total, previousId, nextId, label, href }` or `null`; the browse
  control is hidden unless the remembered list matches the origin.
- **Book origin** (`bookview/book-origin.ts`). `pandalibrary.book-origin` in
  per-tab sessionStorage holds `{ href, label }`. Entering the book area
  from a list records it; reader/editor child flows never overwrite it.
  Login/setup and unsafe or external URLs are excluded. Origin scroll
  restoration runs again after asynchronous Dashboard rows load.

### Details tab assembly

The responsive grid is one column below 768 px, two columns from 768 px
and three columns from 1280 px. The left column holds the cover (with the
only format badge), Read/Resume plus the retained icon status menu,
Download, Add to shelf, and shelf tags. The centre holds the title, rating,
borderless transparent inline status control, Overview and Reviews. The
right holds Details (including metadata sources and the online admin pencil),
Editions and identifiers. Related books remain below the grid.

The client shell applies the resolved locale to document language/direction
at startup and after loading online/offline account preferences. The
embedded static HTML cannot determine the viewer's language; keeping its
language attribute in sync also makes the language picker's current option
and assistive technology agree with English/Chinese Details content.

Shelf tags link to their shelf (Favorites uses its system route and localized
name). Editable manual shelves have a corner X, visible on hover,
focus-within and touch, with confirmation before DELETE. Admins can manage
shared shelves; readers can manage their own private shelves, including
Favorites. The existing downward Add-to-shelf popover disables current
memberships and updates tags immediately; removal rolls back visibly on
failure. Neither operation deletes the book.

The Details pencil opens `/books/{id}/edit` and is hidden offline or for
non-admins. Distinct metadata source names, a Show fields disclosure and
optional cover source are inside Details. The bottom shelf form, cover-area
back/edit links, hero format chips, Personal review link, separate Metadata
sources card and Your reading card are removed. Reading history is in
Activities, not duplicated on Details.

Reviews use `book_reviews` (migration 00007), not private book-level notes.
One plain-text review per author/book is visible to everyone who can see
that book. The viewer's review is pinned with edit/delete; admins may delete
others but cannot edit them. Other reviews are newest-updated first, 20 per
page, with Show more reviews. Plus opens the inline editor only when the
viewer has no review. Reviews are online-only; no note content is migrated
or exposed. See [ADR-0007](../decisions/0007-public-reviews-private-notes.md).

## 3. Events

Defined in `bookview/events.ts`; both are `window` `CustomEvent`s.

| Event | Detail | Producer | Consumers |
|---|---|---|---|
| `pandalibrary-quick-view` (`QUICK_VIEW_EVENT`) | `{ bookId, book?, trigger }` | `openQuickView()` from cover Info buttons; records `document.activeElement` as `trigger` | `QuickViewHost` (mounted once in `AppShell`) |
| `pandalibrary-book-state-changed` (`BOOK_STATE_CHANGED_EVENT`) | `{ bookId }` | `notifyBookStateChanged()` after every status, rating, date or session change | the book-state cache refreshes that book; open views reload it, and started status-filtered dashboard rows and automatic shelf rows refresh their feeds |

Shelf membership changes keep using the existing
`pandalibrary-shelves-changed` event.

## 4. UI kit inventory (`web/src/lib/bookview/`)

Later features import these and must not fork them.

| Module | Purpose |
|---|---|
| `BookCover.svelte` | 2:3 real cover with `onerror` fallback to the cloth cover; generated cover has `role="img"` named by the title |
| `FormatBadge.svelte` | Top-left format pill (`EPUB +1`, tooltip lists all formats) |
| `CoverActions.svelte`, `CoverProgress.svelte` | Cover-only tile chrome: status badge, hover/focus Info and Play, and progress; persistent Info and progress on touch |
| `RatingStars.svelte`, `rating.ts` | Half-star rating display/editor (1–10 scale) |
| `ReadStatusMenu.svelte`, `StatusIcon.svelte` | Localized eight-status menu and reusable status icons; **Re-reading** is an explicit stored status, independent of attempt history |
| `ProgressRing.svelte` | Circular progress used by Details and the Reading Log |
| `ExpandableText.svelte` | Clamp with "Show more" |
| `IdentifierLinks.svelte`, `identifiers.ts` | External links from identifiers (§ plan decision 5) |
| `Icon.svelte` | Inline SVG icons (no icon dependency) |
| `cover.ts` | Deterministic cloth palettes, title scaling/truncation, format ordering and tones |
| `format.ts` | Size, duration, percent, date and relative-time formatting helpers |
| `user-book.ts` | Status labels/tones and `saveUserBook` — `user_books` upsert through `/sync/push` (LWW) |
| `read.ts` | `readTarget(book, account)` — resume the saved file or the first readable format |
| `book-states.svelte.ts` | Account-scoped, coalescing status/progress store for cover tiles, with offline replay |
| `log-api.ts` | Typed reading-log client (`getReadingSummary`, `listBookSessions`, `deleteBookSession`, `addManualSession`, `viewerTimezone`) |
| `reviews-api.ts`, `details/ReviewsCard.svelte`, `details/ReviewEditor.svelte` | Visibility-scoped public reviews, pinned own review, pagination and moderation |
| `details/OverviewCard.svelte`, `details/DetailsPanel.svelte` | Description, metadata fields/sources and admin edit link |
| `details/book-shelves.svelte.ts`, `details/BookShelfTags.svelte` | Reactive membership store, confirmed removal with rollback, permission-aware tags |

Feature folders: `quickview/` (drawer), `details/`, `files/`, `log/`,
`highlights/` (one per tab).

## 5. Cover generation, tiles and state

Covers are generated client-side; there is no server image.

- Shown when the book has no cover or the real cover fails to load.
- An integer hash of `book.id` chooses one of eight cloth palettes: navy,
  forest, ochre, khaki, rust, taupe, burgundy or slate-teal. A noise texture,
  darker spine and double inset frame surround a cream label. The label holds
  an optional series eyebrow, serif title and optional subtitle; an ornament
  and the first author sit at the bottom. Dark ink on the light palettes and
  gold on dark cloth meet at least 4.5:1 against the rendered texture in the
  real-browser contrast test.
- Title size follows grapheme count, capped at 80 graphemes (`Intl.Segmenter`,
  ending in "…") and clamped to five lines (three on small covers). The first
  author is truncated on one line. Text scales with container query units.
- Format badge: the preferred format in the order epub, pdf, cbz, azw3, mobi,
  fb2, fbz (unknown formats sort last alphabetically); `+N` when there are
  more. Tones: EPUB emerald, PDF red, CBZ amber, AZW3/MOBI sky, FB2/FBZ violet.
  No badge without files. Search results get the generated cover and Info only
  (they carry no files).
- Grid and carousel cards contain no title or author under the cover; the
  details link retains the title as accessible description and tooltip. List
  and search views retain text. Editable manual shelves add a remove button
  below the tile. Bookheap grid tiles retain title, filename, selection and
  heap-specific status because staged files are not catalog books.
- `--aspect-book` is `2 / 3`; `--spacing-book` is `13rem` (208 px at the
  default root size). At `sm` and above, `.book-grid`, dashboard/related rows
  and Bookheap use that width. Below `sm`, grids use two fluid columns and
  horizontal rows use 9rem tiles. Both catalog and heap tiles share
  `.book-tile-lift`; hover/focus lifts 4 px, while touch and reduced-motion
  settings disable the transform.
- The top-right badge shows the localized stored status and icon; unread is
  visible on hover/focus (always on touch). The menu is placed in the
  top layer, or moved to the document body when popovers are unavailable, so
  scrolling rows do not clip it. Offline badges are read-only; search results
  do not show one. Progress above zero appears on hover/focus and on touch;
  `finished` displays 100%. On touch, the author footer reserves room for
  the persistent Info button and may truncate sooner. Play resumes the saved
  readable file, otherwise it starts the first supported format. It replaces
  the former dashboard Resume button.
- The eight stored statuses are `unread`, `want_to_read`, `reading`,
  `on_hold`, `rereading`, `finished` (labelled Read), `skimmed`, and
  `abandoned`. `on_hold` and `rereading` count as in progress; `skimmed`
  joins the Read dashboard section but does not increment finished-book stats.
  Migration 00005 preserves existing rows; rollback maps `on_hold` and
  `rereading` to `reading`, and `skimmed` to `finished`.
- Applied web/KOReader progress promotes missing, `unread` or `want_to_read`
  status to `reading` above zero. At 99%, these statuses and `reading` or
  `rereading` become `finished`. Manual `on_hold`, `skimmed`, `abandoned`
  and `finished` statuses stay unchanged. Derived writes use server time,
  preserve ratings, respect newer status clocks, and get pullable revisions.
  Migration 00006 backfills existing books. Offline outbox replay mirrors
  these transitions without queuing additional mutations.
- Entering `rereading` resets saved progress to zero and clears its locator,
  retaining the file, source and device. Selecting it again does not reset
  progress. The status patch starts a fresh `started_at` and clears
  `finished_at`.
- `bookState(id)` returns a stable reactive `{status, percentage, loading,
  error}` per book and account. Requests in one microtask are coalesced and
  split into batches of at most 100. Concurrently loading dashboard rows
  hold their cover requests until the rows render, with a one-second maximum
  wait if a row stalls; later loads or additional batches can issue another
  request. A missing row means unread without progress.
  `refreshBookStates(ids?)` refreshes cached IDs. The store invalidates on
  account changes, book-state events and successful sync; offline it reads
  IndexedDB rows and replays queued mutations. Failed loads are logged and
  expose `error` rather than displaying a fabricated state.

## 6. Attempt derivation

Attempts are derived on the server (`internal/reading/booklog*.go`), never
stored:

1. Sessions are ordered by `started_at`.
2. A new attempt starts at a session whose start position (end position when
   the start is null) is ≤ 10% after the current attempt reached ≥ 95%, or at
   the first session that starts after `user_books.finished_at` when the
   current attempt began before it. An explicit re-read also starts a new
   attempt at the first session on or after `user_books.started_at` when the
   current attempt began before that timestamp.
3. An attempt is `completed` when it reached ≥ 95% or contains `finished_at`.
   Otherwise the last attempt is `in_progress`; earlier ones are `stopped`
   (an explicit re-read can restart an unfinished attempt).

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
| GET | `/api/v1/me/book-states?ids=1,2` | batched visible-book status and progress for cover tiles |
| GET | `/api/v1/me/books/{id}/reading-summary?timezone=` | Activities summary |
| GET | `/api/v1/me/books/{id}/sessions?range=&timezone=&limit=&cursor=` | Activities sessions table |
| DELETE | `/api/v1/me/books/{id}/sessions/{sessionId}` | Activities delete |
| POST | `/api/v1/sync/push` | status, rating, dates, private notes, manual sessions, progress lifecycle |
| GET | `/api/v1/books/{id}/reviews?limit=&cursor=` | Reviews (mine separately, paged others, total) |
| PUT / DELETE | `/api/v1/books/{id}/reviews/me` | Write/edit or delete own review |
| DELETE | `/api/v1/books/{id}/reviews/{reviewId}` | Admin moderation |
| GET | `/api/v1/me/notes/export?book_ids={id}` | Highlights export |
| GET | `/api/v1/books/{id}/files/{fileId}` (`download_url`) | Read, download, offline save |

The response shapes are in [system.md §5 "Reading log contract
(BV2)"](./system.md#reading-log-contract-bv2) and the
[plan](../plans/book-view-plan.md#shared-api-contract-bv1-bv2-json-timestamps-rfc3339-utc).
The public review contract is in
[system.md](./system.md#book-review-contract-bd3).

## 8. Offline behaviour

| Surface | Offline behaviour |
|---|---|
| Book context | Falls back to the IndexedDB copy of a downloaded book; otherwise shows the not-available-offline state |
| Quick view drawer | Uses the cached book; hides Collections and the admin Edit metadata link |
| Details | Read-only notice; status/rating/dates are read-only; Download/Add and metadata edit are hidden; shelf tags have no X; Reviews shows its online-only message and makes no requests |
| Files | Lists cached files; reading saved copies works; download, save and remove actions that need the server are disabled |
| Activities | Shows its connection-required message with a retry that reloads once back online |
| Highlights | Reads highlights and notes from the local reader state; export is disabled |
| Cover tiles | Reads synchronized state and pending outbox mutations from IndexedDB; status badges are read-only while offline |

Changes made offline in the reader (progress, highlights, sessions) still go
through the outbox and appear in these views after syncing.

## 9. Tests

- Unit (vitest): cover helpers, browse/book contexts, view models for each tab.
- Mocked Playwright: `covers`, `quickview`, `details-shell`, `details`,
  `files`, `log`, `highlights` specs under `web/src/lib/bookview/**`.
- Real server: `web/src/routes/bookview-real.e2e.ts` seeds books through the
  API and walks catalog → drawer → every tab → reader, then checks that the
  reading summary and sessions survive a server restart.
- BD integration: `web/src/routes/bookdetail-real.e2e.ts` verifies R1–R13
  with two users, private/shared/Favorites membership, reader/editor origin
  round trips, web/KOReader lifecycle, re-read attempts, public reviews and
  private notes. A copied version-5 database is upgraded by the real binary;
  its backfilled row is returned to an old sync cursor. The visual matrix
  covers 360/768/1440 px, light/dark, menus/editor/hover/touch, 21 real review
  authors and pagination, keyboard flows, reduced motion and UI contrast
  of at least 3:1. Screenshots attach to Playwright results; set
  `PANDA_BD8_SCREENSHOTS` to persist a copy outside test-results.
- Cover integration: `web/src/routes/covers-real.e2e.ts` imports 50 books,
  exercises all eight statuses and the saved file, checks batching and tile
  sizing, measures rendered cloth contrast, and captures rest/hover/menu
  screenshots at 360, 768 and 1440 px. The migration test upgrades a copied
  version-4 database and checks preserved rows and rollback mappings.
