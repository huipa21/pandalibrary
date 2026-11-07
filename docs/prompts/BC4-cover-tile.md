# BC4: Cover tile — lift, status badge, progress bar, cover-only cards

- Status: Done
- Wave: 2. Dependencies: BC1, BC2, BC3 (BC2 applied uncommitted from `task/bc2`)
- Can run in parallel with: BC5
- Branch/worktree: `master` (uncommitted)
- Migration: no

## Read first

- [Book Cover plan](../plans/book-cover-plan.md): decisions 5 and 6, the
  "Tile" contract.
- BC1, BC2 and BC3 hand-offs in [progress/README.md](../progress/README.md)
  (`StatusIcon`, `statusTone`, `ReadStatusMenu variant="badge"`,
  `bookState()`, the `--spacing-book` value, `BookCover` props).
- `web/src/lib/bookview/CoverActions.svelte` (overlay, Info, Play via
  `readTarget`, the touch rules), `web/src/lib/catalog/BookCard.svelte`,
  `web/src/lib/search/SearchResultCard.svelte`,
  `web/src/lib/bookview/format.ts` (`formatPercent`),
  `web/src/lib/sync/client.ts` (offline detection), `bookview/covers.e2e.ts`.
- **Pasted Image 2** (what to remove): a card with a cover, a big 45% dark
  overlay with Info + Play, the title text below, and a "Resume reading"
  button. Only the cover and the Info/Play hover buttons should remain.

## Goal

Every book tile is just the cover. Hovering lifts it and shows Info/Play
plus a progress bar with a percentage, and the reading status sits in the
top-right corner where it can be changed in place.

## Scope

**Owns:** `CoverActions.svelte`, new `bookview/CoverProgress.svelte`,
`catalog/BookCard.svelte`, the variant rename in `SearchResultCard.svelte`,
`covers.e2e.ts` tile cases, and `bc4.*` messages.

**Must not touch:** page grids/rows (BC6/BC7), Bookheap (BC5), cover
artwork (BC3), and status/states internals (BC1/BC2; import only).

## Subtasks

### BC4.1 – Tile structure and lift

> `CoverActions` variants: `tile` (`grid` stays an alias), `list` and
> `search`. For `tile`: the root is `w-full`. A `.tile` wrapper handles the
> lift. On `@media (hover:hover)`, `.tile:hover, .tile:focus-within` get
> `transform: translateY(-4px)` and a deeper shadow
> (`0 10px 24px -6px rgb(15 23 42/.35)`), with `transition: transform 150ms
> ease-out, box-shadow 150ms`. Under reduced motion there is no transform
> (shadow only). Lighten the overlay dim to `rgb(15 23 42/20%)`. Info and Play
> stay centred, unchanged in behaviour (Play = `readTarget`: resume, else
> first readable). `list` and `search` keep today's layout.

### BC4.2 – Status badge (top-right)

> For `tile` and `list` (not `search`): read `bookState(book.id)` from BC2.
> In `absolute top-2 right-2 z-10`, render
> `<ReadStatusMenu variant="badge" bookId userBook=…>`. Build the `userBook`
> argument from the state (BC1's menu needs `UserBook | null`; when only a
> status is known, pass a minimal preview via `previewUserBook`). Visibility:
> while `loading`, render nothing. For a status other than `unread`, always
> visible. For `unread`, only on hover/focus-within (opacity transition) and
> always on `hover:none`. Offline read-only (`offline` from
> `sync/client.ts`, when the user cannot push), render a non-interactive
> chip (`role="img"`, the same accessible text). Clicking the badge must not
> follow the cover link: `stopPropagation`, and it is a sibling of the
> `<a>`, not inside it. After a change, BC1's `saveUserBook` emits
> `BOOK_STATE_CHANGED`, which refreshes the store. Check that the menu is not
> clipped by `overflow-hidden` ancestors (the tile must not clip it; use the
> BV5 upward/flip approach inside dashboard rows).

### BC4.3 – Progress bar on hover (`CoverProgress.svelte`)

> Props `{ percentage: number | null; status: ReadStatus }`. The value
> shown = `status === 'finished' ? 1 : percentage`; render nothing when it is
> null or ≤ 0. Markup: `absolute inset-x-0 bottom-0` with a gradient
> `from-black/70 to-transparent`, `px-2 pb-2 pt-6`, a row with a 4 px rounded
> track (`bg-white/30`) and fill (`bg-emerald-400`, width %), and a
> `text-[11px] font-semibold text-white tabular-nums` label (`formatPercent`).
> Use `role="progressbar"` with `aria-valuenow` and `aria-label` =
> `bc4.progress` ("{percent} read"). Shown on hover/focus-within (opacity
> 150 ms), always on `hover:none`. It sits above the overlay dim but must not
> cover the Info/Play buttons (buttons are centred; the bar is at the bottom).

### BC4.4 – Cover-only BookCard

> `BookCard` grid mode: the `<li>` has no border/padding/background (the
> tile carries the shadow). Render `<CoverActions variant="tile">`, then
> `{@render actions?.()}` only when given (`mt-2`). Remove the title,
> subtitle, authors and series text. Keep the title as the cover link's
> accessible description (`aria-describedby` already exists) and add
> `title={book.title}` on the link for the tooltip. Pass `subtitle` and
> `series?.name` through to `BookCover` (BC3 props). List mode is unchanged
> except the cover gains the badge.

### BC4.5 – Tests

> Extend `covers.e2e.ts` (mock `/api/v1/me/book-states`): hover lifts
> (transform is not none; none with `reducedMotion`); the badge shows the
> right icon/name for `reading` and is hidden for `unread` until hover;
> selecting "On hold" from the badge pushes a `user_books` mutation and the
> badge updates; the progress bar shows `42%` on hover, nothing for 0/null,
> and 100% for finished; Play resumes the saved file (`/read/{id}/{file}`);
> there is no title text under grid covers; touch emulation
> (`hasTouch`, `hover:none`) shows the badge + bar persistently; one
> `book-states` request per grid page.

## Out of scope

Dashboard Resume button removal and row widths (BC6), grid widths (BC7).

## Acceptance criteria

- [x] Requirements R2-R6 hold on any `BookCard` grid.
- [x] Keyboard: Tab reaches the cover link, then the badge, Info and Play.
      Focus shows the lift, the bar and the badge.
- [x] No layout shift when states load.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src\lib\bookview
pnpm --dir web exec playwright test covers.e2e.ts quickview.e2e.ts
```

## Hand-off

- Grid `BookCard` no longer adds a border, background, padding, title,
  authors or series. The cover link keeps the title as a description and
  tooltip. The optional actions snippet still renders below the cover, so
  BC6 must remove the dashboard's Resume snippet; BC6/BC7 own row and grid
  widths.
- `CoverActions` accepts `tile` and the existing `grid` alias, as well as
  `list` and `search`. List retains its text; on narrow list covers
  the format badge moves below the status badge to avoid overlap. Search does
  not request states.
- Badge menus use the native top layer, with a body-portal fallback, so they
  remain usable in clipped horizontal scrollers. Before saving, they fetch
  the full user-book record and replay queued changes to retain ratings and
  reading dates. Failed state loads hide the badge rather than implying
  unread, and the store exposes an `error` flag.
- The BC2 commits were applied without a commit because that prerequisite was
  absent from this checkout. Startup sync is folded into the first batched
  request when possible, with a bounded wait; this avoids duplicate initial
  requests without blocking on a stalled sync.
