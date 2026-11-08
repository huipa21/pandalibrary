# Book Detail (BD): back navigation, shelf tags, metadata card, status lifecycle, Overview and Reviews

Status: Planned (prompts Ready). Requested 2026-11-08. Baseline: `d6014b0`
(`master`). Local issue specifications only; nothing is published to GitHub.
Reference screenshot (current page, before):
[assets/book-detail-before.png](./assets/book-detail-before.png).

## Request (as given, split into requirements)

| # | Requirement | Request item |
|---|---|---|
| R1 | Remove the bottom **Shelves** section (select + "Add to shelf" form). The **Add to shelf** button under the cover adds the book to a shelf. | 1 |
| R2 | Show the book's shelves as **tags** with an **X** at the tag's top-right corner. X removes the book from that shelf after the user confirms. | 1 |
| R3 | Remove the **Back to library** link under the cover buttons. | 2 |
| R4 | The header's **‹ Books** item becomes a **back icon only**. It returns to where the user came from: Dashboard, All Books, a shelf (or any other list). Today it sometimes opens the reader. | 2 |
| R5 | The **Details** card gets an **edit icon** at the top right that edits the metadata. Remove the **Edit metadata** button under the cover. | 3 |
| R6 | Move **metadata sources** into the Details card. Remove the **Metadata sources** card. | 3 |
| R7 | Remove the **format chips under the title** (the cover already shows the format badge). | 4 |
| R8 | Remove the **Personal review** link next to the reading status. | 4 |
| R9 | The reading-status control has **no border** and the **same background** as the controls around it, with a **down arrow** that opens the status menu. | 5 |
| R10 | **Default status lifecycle:** a new book is *Unread*. Any progress makes it *Reading*. Finishing makes it *Read*. The other statuses are set manually. Setting **Re-reading** on a finished book **restarts the progress and the reading lifecycle**. | 5 |
| R11 | Rename **Synopsis** to **Overview** (the book's description). | 6 |
| R12 | Add a **Reviews** card under Overview that shows **all users' reviews**. A **Plus** button (not "Write") writes my own review. | 6 |
| R13 | Remove the **Your reading** card. Its content is already in the Reading Log tab, which is renamed **Activities**. | 6 |

## Assessment of the current code

- **Page structure.** `web/src/routes/books/[id]/(tabs)/+layout.svelte`
  hosts `bookview/BookTabs.svelte` (back link, tabs, previous/next) and the
  tab pages. The Details tab is `bookview/tabs/DetailsTab.svelte`. It has a
  left aside (cover, Resume button + icon status menu, Download, Add to shelf,
  Edit metadata, Back to library), a centre column (`DetailsHero`,
  `SynopsisCard` with the embedded `ReviewEditor`, `ReadingCard`), a right
  aside (`DetailsPanel` "Details", `EditionsCard`, an Identifiers card, the
  "Metadata sources" `<details>` card), then `RelatedBooks` and finally
  `<AddToShelf>` (`#book-shelf`).
- **R1/R2.** The cover's **Add to shelf** is only an anchor to `#book-shelf`.
  Removing the bottom section therefore needs a real picker:
  `bookview/quickview/ShelfPopover.svelte` (icon trigger, opens upward) already
  does this for the quick view. The membership API exists:
  `GET /api/v1/books/{id}/shelves` (`getBookShelves` in `catalog/api.ts`)
  returns the viewer-visible manual shelves, including Favorites.
  `removeBookFromShelf(shelfId, bookId)` exists in `shelves/api.ts`. Who may
  edit membership is `offersShelfManagement(shelf, viewer)` in
  `shelves/form.ts` (admin, or owner of a private shelf), excluding automatic
  shelves. **No server work is needed.**
- **R4 root cause (the "opens the book" bug).** `BookTabs` uses
  `history.back()` when the layout's `backUsesHistory` is true. The layout
  sets it on its first `afterNavigate` when the previous URL is not under
  `/books/{id}`. The reader's Back link and close action
  (`routes/read/[bookId]/[fileId]/+page.svelte` lines ~399 and ~695) **push**
  `/books/{id}`. So after *Dashboard → Book → Resume → reader Back*, the
  remounted layout sees `from = /read/…`, sets `backUsesHistory = true`, and
  **Books goes back into the reader**. Entering straight from a list works,
  which is why the behaviour looks random. Two more gaps:
  - The Dashboard never calls `rememberBrowseContext`, so the non-history
    fallback (`browseNeighbors(bookId)?.href ?? '/books'`) goes to a **stale**
    list from an earlier visit, or to All Books. Previous/next can also show
    a stale list.
  - The metadata edit page also pushes `/books/{id}`. It is treated as "book
    area", so it falls back to the stale or `/books` href.
- **R5/R6.** The edit page `/books/{id}/edit` (W6) exists. The visibility
  flag is `context.canEditMetadata` (admin). Metadata provenance is
  `book.field_sources[]` (`field`, `source`, `source_ref`, `chosen_at`) plus
  `book.cover_source` (today a line under the cover).
- **R7/R8/R9.** `details/DetailsHero.svelte` renders the format chips (with
  the identifier chips), the "Personal review" link and
  `<ReadStatusMenu variant="pill">` (white, bordered, rounded). LogSummary also
  uses `pill`. The quick view and the Resume row use `icon`, and tiles use
  `badge`.
- **R10.** The status is **purely manual today**. No code changes
  `user_books.status` when progress is written. The screenshot shows *Unread*
  at 7%. Progress from the web reader **and KOReader** goes through
  `reading.Service.PushTx` (`internal/reading/service.go`, `reading_progress`
  case), so this is the single place for server rules. Offline displays
  replay queued writes with `replayMutations` in `web/src/lib/sync/state.ts`
  (used by the reader state and `book-states.svelte.ts`).
  `statusPatch(…, 'rereading')` already sets `started_at = now` and clears
  `finished_at`, but nothing resets progress. Reading attempts are derived in
  `internal/reading/booklog.go` `deriveAttempts` (restart at ≤10% after ≥95%,
  or after `finished_at`).
- **R11/R12.** `SynopsisCard` shows the description and embeds `ReviewEditor`.
  The "review" is the **latest book-level note** (`notes.highlight_id IS
  NULL`) of the current user (`details-data.ts` `latestReview`). The
  **reader also creates book-level notes** ("Add note"), so these are
  private notes. They cannot be shown to other users. **There is no
  multi-user review storage or API.**
- **R13.** `details/ReadingCard.svelte` duplicates the Reading Log's
  `LogSummary` / `SessionsTable` / chart. The tab key/path is `reading-log`
  (`BookTabs.svelte` `BOOK_TABS`, `bookTabPath`). `ReadingCard` and three e2e
  specs link to it.

## Product decisions used by these prompts

Change them here and in the affected prompts before launching a wave.

1. **Return target ("origin").** When the user enters the book area
   (`/books/{id}` tabs) from any page outside it, that page
   (`pathname + search`) is stored as the **origin** in `sessionStorage`
   (per tab). The reader (`/read/{id}/…`) and the metadata editor
   (`/books/{id}/edit`) are **child flows**: returning from them never
   replaces the origin. Book-to-book moves inside the book area (related
   books, previous/next) keep it too. The back icon goes to the origin. It
   uses `history.back()` only when the entry directly before the current one
   is the origin (this restores the list's scroll position). Otherwise it
   uses `goto(origin)`. Without an origin (a deep link in a fresh tab), it
   goes to `/` (Dashboard).
2. **Back icon** = a 36 px round icon button with a left arrow, no text. Its
   accessible name and tooltip are "Back to {label}" when the label is known
   (the browse-context label for that origin, or the route name: Dashboard,
   All books, Search…), otherwise "Back".
3. **Previous/next** only shows when the remembered browse context's `href`
   equals the origin. The Dashboard records a browse context **when a tile in
   a row is activated** (that row's IDs, the row title, `href: '/'`), because
   several rows render at once.
4. **Tab rename:** "Reading Log" → **"Activities"** (zh "阅读动态"). The
   path becomes `/books/{id}/activities`. The old `/books/{id}/reading-log`
   redirects (replace) to it.
5. **Shelf tags** live in the **left column under the cover action buttons**,
   with a small "Shelves" label. They sit next to the Add to shelf button,
   where membership is managed. Each tag is a `bg-slate-100` rounded chip that
   links to the shelf (Favorites uses its localized name and
   `/shelves/system/favorites`). Tags you can edit show a 16 px round **X**
   badge on the chip's top-right corner. It is visible on hover/focus-within
   and always visible on touch (`hover: none`). The X asks for confirmation
   (`window.confirm`, as on the shelf page): "Remove “{title}” from
   “{shelf}”?". On success the tag disappears and
   `pandalibrary-shelves-changed` is dispatched. With no shelves, the label
   shows "Not on any shelf".
6. **Add to shelf** under the cover opens the existing shelf popover
   (`ShelfPopover`, new `variant="button"`, opens **downward**). Shelves that
   already contain the book show a check and are disabled. Adding updates the
   tags at once.
7. **Details card edit icon:** a pencil icon link at the card's top right to
   `/books/{id}/edit`. It is shown only when `canEditMetadata` (admin) and
   online. Its accessible name is "Edit metadata". The per-date pencils for
   *Date started/finished* stay (personal data, not metadata).
8. **Metadata source in Details:** a "Metadata source" row lists the distinct
   `field_sources[].source` values (comma separated, `–` when none). A
   "Show fields" disclosure inside the card lists `field: source ·
   source_ref`. A "Cover source" row shows `book.cover_source` when set. The
   line under the cover and the Metadata sources card are removed.
9. **Status control style (R9):** a new `ReadStatusMenu` variant `inline`.
   It has no border and a transparent background (the same as the hero row
   around it, which sits on the page background), with a `hover:bg-slate-900/5`
   tint and the emerald focus ring. It shows the status icon (tone colour),
   the label and a `chevron-down`. Offline it shows the same layout without
   the chevron and is not interactive. `pill` stays for LogSummary.
10. **Status lifecycle (server-authoritative, R10).** Inside the same
    transaction as an **applied** (not stale) `reading_progress` upsert, with
    `p` the new percentage:
    - no row, `unread` or `want_to_read`, and `p > 0` → **`reading`**
      (`started_at = COALESCE(started_at, now)`).
    - `unread`, `want_to_read`, `reading` or `rereading`, and
      `p ≥ 0.99` (`AutoFinishThreshold`) → **`finished`**
      (`finished_at = now`, `started_at = COALESCE(started_at, now)`).
    - `on_hold`, `skimmed`, `abandoned` and `finished` are **never changed
      automatically** (manual states win).
    - The derived write uses `updated_at = server now` and a new `rev`. It
      happens only when the status changes and only if
      `now > user_books.updated_at` (LWW-safe). Web and KOReader both get it
      because both use `PushTx`.
    - **Re-read restart:** when an applied `user_books` upsert changes the
      status **to `rereading`** from any other status, the server also resets
      `reading_progress` for that user and book (`percentage = 0`,
      `locator = NULL`, keep `book_file_id`/`source`/device, `updated_at =
      now`, new `rev`). `started_at = now` and `finished_at = NULL` come from
      the client patch, as today. The next attempt starts at the first
      session after the re-read's `started_at` (new `deriveAttempts` rule).
      Reaching ≥ 0.99 again finishes it (`rereading → finished`).
    - **Backfill (migration 00006):** for existing data, apply the first two
      rules once: rows with progress > 0 and status `unread`/`want_to_read`
      (or no `user_books` row) become `reading`, or `finished` when ≥ 0.99.
      Each changed row gets a fresh `rev` from `sync_counter` so clients pull
      it.
    - **Offline mirror:** `replayMutations` applies the same two progress
      rules and the re-read reset to its local result, so an offline or
      unsynced display matches what the server will do.
11. **Reviews are a new entity, separate from notes.** Existing book-level
    notes stay **private** and are **not migrated** (the reader also creates
    them). Their content is still in Notes and the reader. One review per
    user per book. Plain text up to 10,000 characters, shown with
    `whitespace-pre-wrap` (no Markdown rendering, as today). Any user who can
    see the book can read its reviews. The author may edit or delete their
    review. An **admin may delete any review** (moderation). Each review shows
    the author's display name (username fallback), a relative date and
    "edited" when `updated_at > created_at`. Ratings are **not** shown in v1.
    Reviews are online-only (not part of offline sync). Offline, the card
    shows "Reviews are available when you're online".
12. **Reviews card UI:** the header shows "Reviews" and a count. A round
    **Plus** icon button (accessible name "Write a review") is shown only
    when online and the viewer has no review. **My review** is pinned first,
    with pencil and trash icon buttons (delete asks for confirmation). The
    other reviews follow, newest first, paged with "Show more" (20 per page).
    The editor is an inline textarea (the current ReviewEditor behaviour: a
    character count, Save/Cancel).
13. **Removed:** the `ReadingCard` ("Your reading") component, the bottom
    `AddToShelf` section on the Details tab (the `AddToShelf` component stays
    because other pages may use it; BD7 deletes it if it has no remaining
    users), the Back to library link, the Edit metadata button, the cover
    source line, the Metadata sources card, the hero format chips and the
    Personal review link. The duplicate icon status menu next to Resume is
    **kept** (not requested; see Open questions).

## Shared contracts

- **Origin store** (BD1, `web/src/lib/bookview/book-origin.ts`):
  `rememberBookOrigin(href: string, label?: string)`,
  `readBookOrigin(): { href: string; label: string | null } | null`,
  `isBookChildFlow(pathname: string, bookId?: number): boolean`
  (`/read/…`, `/books/{id}/edit`), `isBookArea(pathname)`. The key is
  `pandalibrary.book-origin` in `sessionStorage`. The href is validated like
  `browse-context.ts` `safeHref`.
- **Tabs** (BD1): `BookTab = 'details' | 'files' | 'activities' |
  'highlights'`. `bookTabPath(id, 'activities')` → `/books/{id}/activities`.
  `bookTabFromPath` maps the legacy `reading-log` to `activities`.
- **Status lifecycle** (BD2): Go `reading.AutoFinishThreshold = 0.99`. Web
  `AUTO_FINISH_THRESHOLD = 0.99` and
  `autoStatus(current: ReadStatus | null, percentage: number): ReadStatus | null`
  (null = no change) in `web/src/lib/bookview/user-book.ts`, used by
  `replayMutations`.
- **Reviews API** (BD3), all under the session middleware. Writes use cookie
  protection.
  - `GET /api/v1/books/{id}/reviews?limit=20&cursor=…` → `200 { "mine":
    Review | null, "items": Review[], "next_cursor": string | null,
    "total": number }` (`total` counts all reviews, including mine).
    `items` excludes `mine` and is ordered `updated_at DESC, id DESC`.
    `limit` is 1-50 (default 20). `404` if the viewer cannot see the book.
  - `PUT /api/v1/books/{id}/reviews/me` body `{ "body": string }` (trimmed,
    1-10,000 Unicode code points; NUL characters rejected because SQLite
    text length stops at NUL) → `200 { "review": Review }` (create or update).
  - `DELETE /api/v1/books/{id}/reviews/me` → `204` (`404` if none).
  - `DELETE /api/v1/books/{id}/reviews/{reviewId}` → admin only, `204`.
  - `Review = { "id": number, "book_id": number, "author": { "id": number,
    "display_name": string }, "body": string, "created_at": RFC3339,
    "updated_at": RFC3339, "mine": boolean }`.
  - Web client `web/src/lib/bookview/reviews-api.ts`: `listReviews(bookId,
    { cursor?, limit?, signal? })`, `saveMyReview(bookId, body)`,
    `deleteMyReview(bookId)`, `deleteReview(bookId, reviewId)`, and the `Review`
    / `ReviewPage` types.
- **Shelf membership** (BD5, `web/src/lib/bookview/details/`):
  `book-shelves.svelte.ts` exports `createBookShelves(getBookId: () => number |
  null)`, which returns `{ items: Shelf[]; status: 'loading' | 'ready' |
  'error'; memberIds: number[]; canRemove(shelf): boolean; remove(shelf):
  Promise<void>; reload(): void }`. It reloads on
  `pandalibrary-shelves-changed` and on book change.
  `BookShelfTags.svelte` takes `{ shelves: ReturnType<typeof
  createBookShelves>; bookTitle: string }`. `ShelfPopover` gains `variant?:
  'icon' | 'button'` (default `icon`) and `placement?: 'up' | 'down'`
  (default `up`).
- **Hero** (BD4): `DetailsHero` props stay the same.
  `<ReadStatusMenu variant="inline">`.
- **Details card** (BD6): `DetailsPanel` gains `canEdit?: boolean`. When it is
  omitted, it reads `getBookContext().canEditMetadata`, so it works without a
  `DetailsTab` change. Metadata sources come from `book.field_sources` and
  `book.cover_source`.
- **Overview/Reviews** (BD7): `details/OverviewCard.svelte` `{ description:
  string | null }`, and `details/ReviewsCard.svelte` `{ bookId: number;
  offline: boolean; isAdmin: boolean }`.

## Tasks and parallel execution

| Wave | Task | Goal | Requirements | Deps | Migration | Prompt |
|---|---|---|---|---|---|---|
| 1 | BD1 | Back icon with origin return, previous/next fix, Activities tab | R4, R13 (rename) | baseline | No | [BD1](../prompts/BD1-back-navigation.md) |
| 1 | BD2 | Automatic reading-status lifecycle + re-read restart (server, backfill, offline mirror) | R10 | baseline | **Yes (00006)** | [BD2](../prompts/BD2-status-lifecycle.md) |
| 1 | BD3 | Multi-user reviews: storage, API, web client | R12 (data) | baseline | **Yes (00007)** | [BD3](../prompts/BD3-reviews-api.md) |
| 1 | BD4 | Hero cleanup + borderless status control | R7, R8, R9 | baseline | No | [BD4](../prompts/BD4-hero-status-control.md) |
| 1 | BD5 | Shelf tags with X + Add-to-shelf popover button | R1, R2 (components) | baseline | No | [BD5](../prompts/BD5-shelf-tags.md) |
| 1 | BD6 | Details card: edit icon + metadata sources | R5, R6 (component) | baseline | No | [BD6](../prompts/BD6-details-card.md) |
| 2 | BD7 | Overview + Reviews cards, Details tab assembly and removals | R1-R3, R5, R6, R11-R13 | BD3, BD4, BD5, BD6 (BD1 for the link) | No | [BD7](../prompts/BD7-overview-reviews-assembly.md) |
| 3 | BD8 | Integration, real-server E2E, visual QA, docs, **full gate** | R1-R13 | BD1-BD7 | No | [BD8](../prompts/BD8-integration.md) |

```text
Wave 1 (6 parallel):
  BD1 back nav + Activities ─┐
  BD2 status lifecycle (Go+DB 00006+offline) ─────────────────────────┐
  BD3 reviews API (Go+DB 00007+client) ─┐                             │
  BD4 hero + status control ────────────┤                             │
  BD5 shelf tags + popover button ──────┤                             │
  BD6 details card ─────────────────────┤                             │
                                        ▼                             │
Wave 2 (alone):  BD7 Overview + Reviews cards + DetailsTab assembly   │
                                        │                             │
                                        ▼                             ▼
Wave 3 (alone):  BD8 integration + real-server E2E + visual QA + docs + full gate
```

- **Why wave 1 is safe:** each task owns different files. BD1 = tab strip,
  layout, origin store, dashboard row. BD2 = reading service, migration
  00006, `user-book.ts`, `sync/state.ts`. BD3 = new review files, migration
  00007, one line in `app.go`. BD4 = `DetailsHero` and `ReadStatusMenu`.
  BD5 = new shelf components and `ShelfPopover`. BD6 = `DetailsPanel`.
  **Nobody but BD7 edits `DetailsTab.svelte`.**
- **Two migrations in wave 1:** the numbers are reserved (BD2 = `00006`,
  BD3 = `00007`). **Merge BD2 first.** BD3 then rebases and re-runs
  `task migrate:sum`. If BD3 is ready first, merge it only after BD2, or swap
  the numbers in both prompts before starting.
- BD7 needs the real components and the reviews client, so it runs alone.
  BD1 only touches the tab strip, so BD7 does not wait for it. BD7 only needs
  BD1's `activities` path for links; the legacy redirect covers the gap.
- **Verification policy:** waves 1-2 run only the targeted checks in their
  prompt. BD8 runs the full gate once.

Worktrees for wave 1:

```powershell
git worktree add ..\pandalibrary-bd1 -b task/bd1 master
git worktree add ..\pandalibrary-bd2 -b task/bd2 master
git worktree add ..\pandalibrary-bd3 -b task/bd3 master
git worktree add ..\pandalibrary-bd4 -b task/bd4 master
git worktree add ..\pandalibrary-bd5 -b task/bd5 master
git worktree add ..\pandalibrary-bd6 -b task/bd6 master
```

In each session: `Implement docs/prompts/BD1-back-navigation.md` (substitute
its own prompt). Do the BDn.m subtasks in order and commit after each one.

## Ownership and merge protocol

Each prompt's Scope section is authoritative.

- **BD1:** `bookview/BookTabs.svelte`,
  `routes/books/[id]/(tabs)/+layout.svelte`, `bookview/book-origin.ts`
  (+ test, new), `bookview/browse-context.ts` (+ test), `routes/books/[id]/(tabs)/reading-log/**`
  → `activities/**` (+ redirect), `tabs/ReadingLogTab.svelte` (heading
  only), `dashboard/DashboardRow.svelte` (browse context on tile activation),
  `bookview/Icon.svelte` (append `arrow-left`), and `details-shell.e2e.ts`.
- **BD2:** `internal/reading/service.go` (`user_books` and
  `reading_progress` cases), `internal/reading/booklog.go` (+ tests),
  `internal/reading/lifecycle*.go` (new),
  `internal/db/queries/reading.sql` (appended queries, + sqlc),
  `internal/db/migrations/00006_*.sql` (+ `migrations.sum`, migration test),
  `web/src/lib/bookview/user-book.ts` (+ test), `web/src/lib/sync/state.ts`
  (+ test).
- **BD3:** `internal/db/migrations/00007_*.sql`,
  `internal/db/queries/reviews.sql` (new, + sqlc),
  `internal/catalog/reviews*.go` (new), `internal/httpapi/reviews*.go` (new),
  one `httpapi.ReviewMount(...)` line in `internal/app/app.go`, and
  `web/src/lib/bookview/reviews-api.ts` (+ test, new).
- **BD4:** `details/DetailsHero.svelte`, `ReadStatusMenu.svelte` (new
  variant only), and the matching hero assertions in `details/details.e2e.ts`.
- **BD5:** `details/book-shelves.svelte.ts` (new),
  `details/BookShelfTags.svelte` (new), `quickview/ShelfPopover.svelte`
  (variant/placement props only), a section appended to
  `bookview/kit-fixture.svelte`, and an optional new `details/shelves.e2e.ts`.
- **BD6:** `details/DetailsPanel.svelte` and its assertions in
  `details/details.e2e.ts`.
- **BD7:** `tabs/DetailsTab.svelte`, `details/OverviewCard.svelte` (renamed
  from `SynopsisCard`), `details/ReviewsCard.svelte` (new),
  `details/ReviewEditor.svelte`, `details/ReadingCard.svelte` (delete),
  `details/details-data.ts` (+ test), `shelves/AddToShelf.svelte` (delete
  only if unused), and `details/details.e2e.ts`.
- **BD8:** merges, seams, `routes/bookdetail-real.e2e.ts` (new), docs.
- **Messages:** only `bd1.*` … `bd8.*` keys in `web/messages/en.json` and
  `zh.json`, merged by key union. Old keys that become unused
  (`bv6.synopsis`, `bv6.personal_review`, `bv4.back`, …) are removed by BD8,
  not by wave tasks (so parallel branches do not conflict). Never edit the
  generated Paraglide output.
- **Shared e2e specs:** a wave-1 task may change only the existing
  assertions that its own change breaks, as small hunks. New behaviour goes
  into the task's own new spec file.
- No new dependencies. No ACL relaxations: reviews and shelf membership use
  the same library-access and hidden-book filters as the catalog.
- Each session edits only its own progress row and prompt status, and appends
  one dated log entry.

## Shared UX contract

Same as the earlier batches: the typed API client and `ApiError`, English and
Chinese copy, accessible names for every icon-only button (back, edit,
plus, X, pencil, trash), visible emerald focus rings, `focus-within`
mirroring hover, explicit loading/empty/error states with Retry,
stale-response suppression when the book changes, offline read-only states,
responsive down to 360 px, and `prefers-reduced-motion` respected.

## Open questions (defaults applied; change before launch if needed)

1. Remove the **duplicate icon status menu next to Resume** too? Default:
   keep it. It is not requested, and it is the only status control visible
   above the fold on mobile.
2. Show the reviewer's **star rating** on each review? Default: no. It would
   expose `user_books.rating` to other users.
3. Offer "Start from my latest book note" when writing the first review?
   Default: no (notes stay private).
4. `AutoFinishThreshold = 0.99`: PDF/EPUB readers rarely report exactly 1.0.
