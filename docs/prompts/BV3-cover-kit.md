# BV3: Cover kit – generated cover, format badge, hover actions, shared primitives

- Status: Ready
- Wave: 1. Dependencies merged: baseline `72c469c`
- Can run in parallel with: BV1, BV2, BV4
- Branch/worktree: `task/bv3` / `..\pandalibrary-bv3`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md): decisions 1, 2, 3, 5 and 9,
  the shared frontend contract (events and UI kit), ownership, and the
  verification policy.
- `web/src/lib/catalog/BookCard.svelte`, `web/src/lib/search/SearchResultCard.svelte`,
  `web/src/lib/catalog/types.ts`, `web/src/lib/dashboard/DashboardRow.svelte`
  and `resume.ts` (`resumeFile`, `savedReadingFile`), `web/src/lib/reader/api.ts`
  (`pushMutation`), `web/src/lib/reader/types.ts` (`readerFormat`, `BookState`),
  `web/src/lib/sync/client.ts` (`currentAccount`), `web/src/routes/layout.css`,
  `web/messages/en.json`.
- The user's screenshots 1-3: the grey "Cover unavailable" boxes become a
  styled title cover; PDF/EPUB pills top-left; two round icons (info,
  read) over a dimmed cover on hover.

## Goal

Every book cover in lists (All Books grid and list, library/author/series/tag
pages, shelves, dashboard rows and search results) shows either the real cover
or a generated title cover, a format pill, and hover/focus actions **Info** and
**Read**. The shared building blocks that BV5-BV9 reuse exist and are tested.

## Scope

**Owns (create):** `web/src/lib/bookview/` → `cover.ts`, `format.ts`, `events.ts`,
`user-book.ts`, `read.ts`, `Icon.svelte`, `BookCover.svelte`, `FormatBadge.svelte`,
`CoverActions.svelte`, `RatingStars.svelte`, `ExpandableText.svelte`,
`IdentifierLinks.svelte`, `ReadStatusMenu.svelte`, unit tests next to them, and
`web/src/lib/bookview/covers.e2e.ts` (mocked). `bv3.*` message keys.

**Shared (localized edits):** `web/src/lib/catalog/BookCard.svelte` (use
`BookCover` + `CoverActions`; keep the title link, metadata lines and the
`actions` snippet), `web/src/lib/search/SearchResultCard.svelte` (generated
cover and the Info action only).

**Must not touch:** `routes/books/**` (BV4/BV6), `bookview/browse-context.ts`,
`bookview/book-context.svelte.ts`, `bookview/tabs/**` (BV4),
`bookview/log-api.ts` (BV2), `catalog/types.ts` and `catalog/api.ts` (BV1),
`AppShell.svelte` (BV5), backend.

## Subtasks

### BV3.1 – Pure helpers and events

> Create `web/src/lib/bookview/cover.ts`: `coverTone(seed: number)` returning one
> of 8 muted tone sets `{bg, spine, text, accent}` as Tailwind classes or CSS
> variables (emerald, teal, sky, indigo, violet, rose, amber, slate; WCAG AA
> text contrast); `truncateTitle(title, max = 80)` using `Intl.Segmenter`
> graphemes with an "…" suffix (it handles CJK and emoji and falls back to
> code points); `FORMAT_ORDER`; `sortedFormats(files)` (unique, lowercased,
> plan order, unknown formats last); `preferredFormat(files)`; and
> `formatTone(format)` (decision 2). Create `format.ts` (`formatSize` moved from
> the book page, plus `formatDuration(seconds)` → `54s`, `2h 56m`, `1m`;
> `formatPercent(fraction)`; `formatRelative(date)` with
> `Intl.RelativeTimeFormat`; and `formatDate(iso)`), all locale-aware. Create
> `events.ts` exactly as the plan's events contract (`openQuickView` stores
> `document.activeElement` on the detail as `trigger`). Add vitest coverage for
> every function, including CJK titles, 1-char titles, empty files and
> duplicate formats.

### BV3.2 – Icons, `BookCover` and `FormatBadge`

> Create `Icon.svelte`: inline 24×24 stroke SVGs (`info`, `play`, `book-open`,
> `external`, `eye`, `folder-plus`, `download`, `x`, `chevron-left`,
> `chevron-right`, `chevron-down`, `trash`, `copy`, `more`, `star`, `star-half`,
> `pencil`, `search`, `plus`, `refresh`, `file`), `aria-hidden="true"`, sized by
> a `class` prop. No icon dependency.
> Create `FormatBadge.svelte` (`files`, `size: 'xs'|'sm'`): the preferred
> format pill, `+N` when there are more, and an accessible/`title` text listing
> all formats. It renders nothing without files.
> Create `BookCover.svelte` with props `{ id, title, authors?: string[],
> coverUrl?: string | null, files?: BookFile[], size?: 'sm'|'md'|'lg',
> badge?: boolean, class?: string, loading?: 'lazy'|'eager' }`. It keeps an
> aspect-[3/4] rounded frame. A real cover renders as `<img>` with
> `object-cover`. It switches to the generated cover on `error`. The generated
> cover (decision 1) uses a tone background, a left spine shade, the
> line-clamped truncated title (serif, balanced) and the first author, and
> scales via `container-type: inline-size`. It has `role="img"` and
> `aria-label={title}`. The format badge overlays the top-left corner when
> `badge`.

### BV3.3 – `CoverActions` and `read.ts`

> Create `read.ts`: `readTarget(book, account)` resolves `{bookId, fileId}`
> using `resumeFile` (saved progress file) and falls back to the first
> `readerFormat`-supported file in `FORMAT_ORDER`. It returns `null` when
> nothing is readable and surfaces `ResumeFileUnavailableError` as the
> fallback. Create `CoverActions.svelte` (props `book`, `variant:
> 'grid'|'list'|'search'`), wrapping `BookCover`. On `(hover: hover)` devices,
> hover or `:focus-within` dims the cover (`bg-slate-900/45`, 150 ms, none with
> reduced motion) and shows two centered 44 px round emerald buttons: Info
> (`aria-label` "Quick view: {title}", calls `openQuickView({bookId, book})`)
> and Read (`aria-label` "Read {title}", calls `readTarget`, then `goto`; it
> shows a busy state and an inline error on failure; it is hidden when no file
> is readable). On `(hover: none)` devices, only a small persistent Info
> button shows bottom-right. The `search` variant has Info only. Buttons stop
> click propagation so they never trigger the title link.

### BV3.4 – Interactive primitives

> Create `RatingStars.svelte` (`value: number|null` on the 1-10 scale,
> `editable`, `onChange`, `size`): five stars with half steps and an `n/5`
> label. When editable, it is a `radiogroup` with arrow-key support and a
> clear option. Create `ExpandableText.svelte` (`text`, `lines` = 4): plain
> text (strip HTML tags with DOMPurify `ALLOWED_TAGS: []`), clamped, with a
> Show more / Show less toggle that appears only when the text overflows.
> Create `IdentifierLinks.svelte` (`identifiers`, `variant: 'icons'|'chips'`)
> from decision 5's mapping, with small rounded square provider buttons
> (letter marks: G, OL, GR, a) and safe external links. Create `user-book.ts`:
> `saveUserBook(bookId, current: UserBook|null, patch)` pushes a `user_books`
> upsert via `pushMutation` (preserving unchanged fields; dates as Unix ms)
> and then `notifyBookStateChanged`. Create `ReadStatusMenu.svelte` (`bookId`,
> `userBook`, `reread?: boolean`, `variant: 'pill'|'icon'`): a menu button with
> the five statuses (localized; **Re-reading** label when `reread &&
> status==='reading'`), keyboard navigation, Escape to close, optimistic
> update with rollback and an error message on `SyncError`. When the user picks
> Reading or Finished and the date is missing, it sets `started_at` or
> `finished_at` to now.

### BV3.5 – Adopt in cards

> Update `BookCard.svelte`: grid mode uses `CoverActions variant="grid"` with
> the badge, and list mode uses `variant="list"` (size sm). Keep all existing
> text, links and the `actions` snippet, so the dashboard Resume button still
> works. Update `SearchResultCard.svelte` to use `BookCover`
> (`authors=result.authors`, no files/badge) inside
> `CoverActions variant="search"`. Remove the now-unused
> `catalog.book.cover_unavailable` usages from these two files only (the key
> stays until BV6 removes the last usage). Add `bv3.*` en/zh messages.
> Add `covers.e2e.ts` (mocked API, following `routes/catalog.e2e.ts`): it
> shows a generated cover with the title for `cover_url: null`, a long title
> truncated with "…", a broken image URL falling back, PDF/EPUB badges and
> `+1`, hover reveals Info/Read, keyboard Tab reaches them, Read navigates to
> `/read/{book}/{file}`, Info dispatches `pandalibrary-quick-view` with the
> book ID (assert via a test listener), and a 390 px viewport shows the
> persistent Info button.

## Out of scope

The drawer itself (BV5), details tabs (BV6-BV9), progress strips on cards.

## Acceptance criteria

- [ ] No list surface shows "Cover unavailable". Generated covers are
      deterministic per book and readable.
- [ ] Format pill top-left on all `Book` list surfaces. Hover/focus actions
      work with mouse, keyboard and touch.
- [ ] UI kit components and helpers match the plan's names and are unit-tested.
- [ ] Existing dashboard/catalog/shelf behavior and their tests are unchanged.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/covers.e2e.ts src/routes/catalog.e2e.ts src/lib/dashboard/dashboard.e2e.ts
```

## Hand-off

Set this prompt to Done and update the BV3 row/log. List the final exported
props of each kit component in the log, so BV5-BV9 can rely on them.
