# Book Cover (BC): cloth default covers, unified cover tiles, status and progress on covers

Status: Implementation and full gate complete; direct comparison with the
original reference images is blocked because they are unavailable in this
session. Requested 2026-11-07. Baseline: `6a6709b` (`master`). Local issue
specifications only; nothing is published to GitHub.

## Request (as given, split into requirements)

| # | Requirement | Reference |
|---|---|---|
| R1 | Books without a cover get a **bookcover-style default**: cloth-coloured board, framed cream title label, author at the bottom | Pasted Image 1 |
| R2 | Remove the big **Resume reading** button under dashboard covers; the hover **Play** button starts *or* resumes reading | Pasted Image 2 |
| R3 | Remove the **title text under the cover** (the cover already shows it, real or generated) | Pasted Image 2 |
| R4 | Hovering a book **elevates** it slightly | — |
| R5 | Hovering shows a **progress bar with percentage** at the bottom of the cover | — |
| R6 | The **reading status** sits at the cover's top-right, with the icon/colour language of the status menu | Pasted Image 3 |
| R7 | **One cover style and size** across Dashboard, Shelves, All Books, Bookheap, etc. The size is **between** today's dashboard cover and All Books cover | — |

## Assessment of the current code

- `web/src/lib/bookview/BookCover.svelte` renders the image or a generated
  cover: a pastel tone from `cover.ts` `TONES` (8 entries, hashed by
  `book.id`), a spine, a title and the first author, with an `aspect-[3/4]`.
  `data-generated-cover`, `role="img"` and `aria-label=title` are relied on by
  `bookview/covers.e2e.ts`.
- `web/src/lib/bookview/CoverActions.svelte` wraps the cover in a link and
  adds a hover overlay (45% slate dim) with **Info** and **Play**. Play calls
  `read.ts` `readTarget()`, which already resumes the saved file
  (`dashboard/resume.ts`) and otherwise opens the first readable format.
  **R2 needs no new read logic.**
- `web/src/lib/catalog/BookCard.svelte` grid mode = cover + title, subtitle,
  authors, series and an `actions` snippet. It is used by `BookBrowser`
  (All Books, library/author/series/tag pages), `DashboardRow` (adds the
  Resume button snippet), `routes/shelves/[id]`, `routes/shelves/system/[key]`
  and `bookview/details/RelatedBooks`. List mode is used by BookBrowser and the
  shelf page.
- Sizes today: dashboard row `[&>li]:w-36 sm:w-40` (144/160 px); related
  books `w-36`; All Books / shelf grid `grid-cols-2 sm:grid-cols-3
  lg:grid-cols-4` (fluid, about 230-260 px at 1440 px); system shelf
  `sm:grid-cols-2 lg:grid-cols-3` (wider still); Bookheap rows 48x64 px
  thumbnails (`bookheap/HeapItemRow.svelte`) with a file icon placeholder.
- **Per-user status/progress are not in list responses.** `catalog.Book` has
  no viewer fields. Status is in `user_books` (`unread|want_to_read|reading|
  finished|abandoned`, a CHECK constraint in `00001_init.sql`) and progress in
  `reading_progress.percentage` (0..1, one row per user+book). The only read
  path is `GET /api/v1/me/books/{id}` (one book). With offline storage, the
  client also has every synced `user_books` / `reading_progress` row in the
  IndexedDB `rows` store (`sync/db.ts`, replayed by `sync/state.ts`).
- "Re-reading" today is *derived* (`readStatusLabel(status, reread)` when the
  reading log has more than one attempt); it is not a stored status.
  `ReadStatusMenu.svelte` lists labels with a check mark and no icons.
- Tailwind v4 with `@theme` in `web/src/routes/layout.css`, so theme tokens
  generate utilities (for example `--spacing-book` gives `w-book`).

## Product decisions used by these prompts

Change them here and in the affected prompts before launching a wave.

1. **Status set = the 8 entries of Image 3.** Stored values:
   `unread`, `want_to_read`, `reading`, `on_hold` (new), `rereading` (new),
   `finished` (label "Read"), `skimmed` (new), `abandoned`. Re-reading becomes
   an explicit stored status. The attempts-derived relabel is removed, so one
   source of truth remains. Semantics: `on_hold` and `rereading` count as
   "in progress" (continue-reading feed, OPDS "Reading now"). `skimmed` counts
   as done (excluded from continue-reading, included in the dashboard "read"
   section). Only `finished` counts toward "books finished" stats.
   *If you do not want new statuses, drop BC1. BC4 keys icons by status, so
   it works with the 5 existing ones.*
2. **Status icons and colours (Image 3):** unread = book outline (slate),
   want_to_read = bookmark-book (violet), reading = open book (blue),
   on_hold = pause bars (amber), rereading = circular arrow (fuchsia),
   finished = book with check (green), skimmed = dashed scan frame (sky),
   abandoned = book with x (rose). Inline SVG only, no icon dependency.
3. **Cover geometry:** aspect **2:3** (book proportion, as in Image 1). The
   standard tile width is `--spacing-book: 13rem` (208 px at a 16 px root
   size), the rounded midpoint of the measured dashboard cover (158 px) and
   All Books cover (257.5 px) at a 1440 px viewport. Below `sm`, grids use
   2 fluid columns and carousels use `w-36`.
4. **Generated "cloth" cover (Image 1):** a deterministic palette from
   `book.id` among 8 cloth colours (navy, forest, ochre, khaki, rust, taupe,
   burgundy, slate-teal). The board has a subtle CSS/SVG-noise texture, a
   darker spine band on the left and an inset double-hairline frame. A cream
   **label plate** with a thin inner rule holds an optional series eyebrow
   (small caps, letter-spaced), the **title** (serif, bold, size stepped by
   length so "Emma" is large and long titles wrap up to 5 lines, 3 on `sm`)
   and an optional italic **subtitle** under a short rule. At the bottom: a
   `— ◆ —` ornament and the **author** in letter-spaced uppercase (gold on dark
   cloth, dark brown on light cloth). No server images and no font
   dependency (existing `font-serif` stack). The accessibility contract stays
   (`role="img"`, title as the name, `data-generated-cover`).
5. **Tile = cover only.** In grid/carousel contexts, `BookCard` renders only
   the cover tile; no title or author text below it (R3). The title stays as
   the link's accessible name and a `title` tooltip. List mode and search
   results keep their text columns, but use the same cover component.
6. **Tile chrome:**
   - Top-left: format badge (unchanged).
   - Top-right: **status badge**, a 28 px round white chip with the status
     icon in its colour. It is always visible when the status is not `unread`.
     For `unread` it appears only on hover/focus. Clicking it opens the status
     menu (Image 3 style: icon + label + check) anchored to the badge. It is
     hidden in search results and offline read-only contexts (shown
     non-interactive).
   - Hover/focus-within: the tile lifts `translateY(-4px)` with a larger
     shadow (150 ms, none under `prefers-reduced-motion`). A light dim
     (`slate/20`) appears and **Info** + **Play** stay centred (Play = start
     or resume).
   - Hover/focus-within: a bottom bar shows a 4 px progress track and the
     percentage label (for example `42%`) over a dark gradient. It only shows
     when progress exists and is above 0. When `finished`, it shows 100%.
   - Touch (`hover: none`): status badge always visible, progress bar always
     visible when progress is above 0, Info stays bottom-right, no lift.
7. **Status/progress data for tiles** come from a new batched endpoint
   `GET /api/v1/me/book-states?ids=1,2,…` (at most 100 IDs; IDs the viewer
   cannot see are omitted). On the client, a coalescing store requests IDs
   rendered in the same microtask together and caches per account. It
   invalidates on `BOOK_STATE_CHANGED_EVENT`, sync pull and account change.
   Offline, it reads the IndexedDB `rows` + outbox replay instead. The
   `catalog.Book` DTO is **not** changed (it is cached offline and shared by
   all lists).
8. **Bookheap** gets a Grid/List toggle (`localStorage`, default **Grid**).
   Grid uses the standard tile (BookCover with the heap thumbnail or a
   generated cloth cover, a selection checkbox top-left, a status chip for the
   heap item status, and the title/file name below because heap items are
   unprocessed files and have no details page). List keeps the current rows
   but the 48x64 thumbnail becomes `BookCover size="xs"`. *Assumption: the
   request names Bookheap, but heap items are not catalog books, so they get
   the style and size, not reading status/progress/Play.*

## Shared contracts

- **Theme tokens** (BC3, `web/src/routes/layout.css` `@theme`):
  `--spacing-book: 13rem`, `--aspect-book: 2 / 3`, and a
  `.book-grid` component class:
  `grid-template-columns: repeat(2, minmax(0,1fr))` below `sm`, then
  `repeat(auto-fill, var(--spacing-book))`, `justify-content: start`,
  `gap: 1.75rem 1.25rem`.
- **`BookCover` props** (BC3): adds `subtitle?: string | null`,
  `series?: string | null`, `size?: 'xs' | 'sm' | 'md' | 'lg'` (`xs` = list
  thumbnails: plate + title only). It keeps every existing prop.
- **Status kit** (BC1, `web/src/lib/bookview/`): `READ_STATUSES` (8, menu
  order of Image 3), `readStatusLabel(status)` (the `reread` param is
  removed), `StatusIcon.svelte` (`{ status, class? }`), and
  `statusTone(status) -> { text: string; ring: string }` in `user-book.ts`.
  `ReadStatusMenu` gains `variant: 'badge'` (28 px chip trigger) and renders
  icon + label + check for every option.
- **Book states** (BC2):
  - API: `GET /api/v1/me/book-states?ids=…` →
    `{ "items": [{ "book_id": 1, "status": "reading", "percentage": 0.42,
    "book_file_id": 7, "updated_at": "RFC3339" }] }`. Rows exist only for books
    with a `user_books` or `reading_progress` row. A missing book is
    `unread`/no progress.
  - Client `web/src/lib/bookview/book-states.svelte.ts`:
    `bookState(bookId): { status: ReadStatus; percentage: number | null;
    loading: boolean }` (reactive), `refreshBookStates(ids?)`.
- **Tile** (BC4): `CoverActions` props become `{ book, variant: 'tile' |
  'list' | 'search', chrome?: boolean }` (`grid` stays an alias of `tile`).
  `BookCard` grid mode renders only `<CoverActions variant="tile">` inside the
  `<li>`. The `actions` snippet still renders under the tile when given; it is
  kept for the shelf page's remove button.

## Tasks and parallel execution

| Wave | Task | Goal | Dependencies | Migration | Prompt |
|---|---|---|---|---|---|
| 1 | BC1 | Extended reading statuses (8) + status icons + Image-3 status menu | baseline | **Yes** (00005) | [BC1](../prompts/BC1-reading-statuses.md) |
| 1 | BC2 | Batched book-states API + client store | baseline | No | [BC2](../prompts/BC2-book-states.md) |
| 1 | BC3 | Cloth generated cover + cover size/aspect tokens | baseline | No | [BC3](../prompts/BC3-cloth-cover.md) |
| 2 | BC4 | Cover tile: lift, status badge, progress bar, cover-only BookCard | BC1, BC2, BC3 | No | [BC4](../prompts/BC4-cover-tile.md) |
| 2 | BC5 | Bookheap grid view + unified heap covers | BC3 | No | [BC5](../prompts/BC5-bookheap-covers.md) |
| 3 | BC6 | Dashboard rows: drop Resume button, standard tile width | BC4 | No | [BC6](../prompts/BC6-dashboard-tiles.md) |
| 3 | BC7 | All Books / entity pages / shelves / related books: standard grid | BC4 | No | [BC7](../prompts/BC7-catalog-grids.md) |
| 4 | BC8 | Integration, real-server E2E, visual QA, docs, **full gate** | BC1-BC7 | No | [BC8](../prompts/BC8-integration.md) |

```text
Wave 1 (3 parallel):  BC1 statuses (Go+DB+menu) || BC2 book-states API+store || BC3 cloth cover + tokens
                              \                        |                       /         \
Wave 2 (2 parallel):           BC4 cover tile (badge, progress, lift, cover-only)     BC5 Bookheap grid
                                   /                    \                                  |
Wave 3 (2 parallel):  BC6 dashboard rows          BC7 catalog/shelf/related grids          |
                                   \                    |                                  /
Wave 4 (alone):                     BC8 integration + real-server E2E + visual QA + full gate
```

- Wave 1 tasks share no files: BC1 = statuses, BC2 = new endpoint + new
  store, BC3 = cover visuals + tokens.
- BC5 only needs BC3, so it runs beside BC4 in wave 2.
- BC6 and BC7 only edit consumers (layout classes, removing snippets), so
  they run in parallel once the tile exists.
- **Verification policy:** waves 1-3 run only the targeted checks in their
  prompt. BC8 runs the full gate once (`task sqlc:check lint test build`,
  `pnpm --dir web check test build`, the full real-server `test:e2e`, and the
  visual review at 360/768/1440 px).

Worktrees for wave 1:

```powershell
git worktree add ..\pandalibrary-bc1 -b task/bc1 master
git worktree add ..\pandalibrary-bc2 -b task/bc2 master
git worktree add ..\pandalibrary-bc3 -b task/bc3 master
```

In each session: `Implement docs/prompts/BC1-reading-statuses.md` (substitute
its own prompt). Do the BCn.m subtasks in order and commit after each one.

## Ownership and merge protocol

Each prompt's Scope section is authoritative.

- BC1: `internal/db/migrations/00005_*.sql` (+ `migrations.sum`),
  `internal/reading/service.go` status validation, `internal/catalog/shelf_rules.go`,
  `internal/db/queries/dashboard.sql` (+ sqlc output), `internal/opds/handler.go`,
  `web/src/lib/bookview/user-book.ts`, `ReadStatusMenu.svelte`,
  `StatusIcon.svelte` (new), and the 3 `reread` call sites.
- BC2: `internal/reading/states*.go` (new), its query appended to
  `internal/db/queries/reading.sql` (+ sqlc), one route in
  `internal/httpapi/reading.go`, `web/src/lib/bookview/book-states*.ts` (new).
- BC3: `BookCover.svelte`, `cover.ts` (+ tests), the `@theme` tokens and
  `.book-grid` in `layout.css`, and the cover cases in `covers.e2e.ts`.
- BC4: `CoverActions.svelte`, `catalog/BookCard.svelte`,
  `bookview/CoverProgress.svelte` (new), `search/SearchResultCard.svelte`
  (variant rename only).
- BC5: `web/src/lib/bookheap/**` only.
- BC6: `web/src/lib/dashboard/DashboardRow.svelte`, `dashboard*.e2e.ts`.
- BC7: `catalog/BookBrowser.svelte`, `routes/shelves/[id]/+page.svelte`,
  `routes/shelves/system/[key]/+page.svelte`, `bookview/details/RelatedBooks.svelte`.
- Messages: only `bc1.*`…`bc8.*` keys in `web/messages/en.json` and
  `zh.json`. Merge by key union. Never edit generated Paraglide output.
- No new dependencies. No ACL relaxations; the states endpoint applies the
  same library-access and hidden-book filters as the dashboard queries.
- Each session edits only its own progress row and prompt status, and appends
  one dated log entry.

## Shared UX contract

Same as the earlier batches: typed API client and `ApiError`, English and
Chinese copy, accessible names for icon buttons (status badge: "Reading
status: Reading. Change"), visible emerald focus rings, `focus-within`
mirrors hover, explicit loading states (the badge and progress render nothing
while loading, so there is no layout shift), stale-response suppression,
responsive down to 360 px, and `prefers-reduced-motion` respected.
