# BV9: Highlights tab

- Status: Done
- Wave: 2. Dependencies merged: BV3, BV4
- Can run in parallel with: BV5, BV6, BV7, BV8
- Branch/worktree: `task/bv9` / `..\pandalibrary-bv9`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md): decision 12, the UI kit, the
  book context.
- The BV3 and BV4 hand-offs in [progress/README.md](../progress/README.md).
- `web/src/lib/bookview/tabs/HighlightsTab.svelte` (placeholder),
  `web/src/lib/reader/api.ts` (`getBookState`), `web/src/lib/reader/types.ts`
  (`Highlight`, `Note`), `web/src/lib/sync/state.ts` (`readerState` for
  offline), `web/src/lib/notes/export.ts` (E1 export, `buildExportPath`),
  `web/src/lib/reader/markdown.ts` (safe note rendering),
  `web/src/routes/notes/+page.svelte` (existing highlight/note presentation),
  `web/src/routes/read/[bookId]/[fileId]/+page.svelte` (how `?bookmark=` jumps,
  around line 84), `web/src/routes/read/reader.e2e.ts`.
- Screenshot 8. Toolbar: search "Search text and notes", a "Notes 2" toggle,
  an "In reading order" select, and icon buttons (filters, compact, export,
  more). The list is grouped by chapter headings with counts; each item shows
  the date, a coloured left bar, the text, an optional NOTE block, and a
  source on the right. Sidebar: "7 marks · 6 chapters", WHEN THEY WERE
  MARKED (mini histogram, busiest week), COLOUR chips with counts, WHERE THEY
  CAME FROM (a bar), and CHAPTERS (name, a coloured bar by highlight colours,
  count).

## Goal

The Highlights tab shows all of the user's highlights and attached notes for
the book. They can be searched, filtered, sorted, viewed compactly and
exported, and a highlight opens the reader at its position.

## Scope

**Owns:** `web/src/lib/bookview/tabs/HighlightsTab.svelte`,
`web/src/lib/bookview/highlights/**` (new: `HighlightsToolbar.svelte`,
`HighlightList.svelte`, `HighlightItem.svelte`, `HighlightsSidebar.svelte`,
`highlights-model.ts` + tests, `highlights.e2e.ts`), and `bv9.*` messages.

**Shared (narrow edit):** in `web/src/routes/read/[bookId]/[fileId]/+page.svelte`,
support `?highlight=<id>` exactly like `?bookmark=`. Find the live highlight
in the loaded state, validate its locator for the format, `goTo` it, and
ignore an unknown ID silently. Add one case to `reader.e2e.ts`.

**Must not touch:** other tabs, the kit internals, backend, the
reader's annotation editing.

## Subtasks

### BV9.1 – Model

> Create `highlights-model.ts`. `buildMarks(highlights, notes)` returns live
> highlights (drops `deleted_at`) with their live notes attached by
> `highlight_id`. Book-level notes are excluded; they are the Details
> review/notes. `filterMarks(marks, { query, colors: Set, notesOnly })` does a
> case-insensitive, diacritic-insensitive match on the text and note bodies.
> `sortMarks(marks, 'reading'|'newest'|'oldest')`, where `reading` sorts by
> `position` then `created_at`. `groupByChapter(marks)` keeps the reading order
> of first appearance; a missing chapter becomes "Untitled section".
> `markStats(marks, now)` returns `{ total, chapters, byColor: [{color, count}],
> byFormat: [{format, count}]` (via `book_file_id` → the book's file format,
> else "Unknown"), `weeks: last 52 ISO weeks counts, busiestWeek }`.
> `colorTone(color)` maps yellow, blue, red, orange, green and purple to
> Tailwind tones (unknown → slate). Unit-test every function.

### BV9.2 – Toolbar and list

> `HighlightsToolbar.svelte`: a search input (debounced 200 ms, `?q=` in the
> URL), a **Notes N** toggle button (`aria-pressed`), a sort `<select>` (In
> reading order / Newest / Oldest, `?sort=`), a filters popover (colour
> checkboxes with counts), a compact toggle (`aria-pressed`, persisted in
> `localStorage`), and **Export**. Export uses the E1 export for this book via
> the existing `notes/export.ts` helpers; when the API is unreachable offline,
> the button is disabled with a tooltip. `HighlightList.svelte` shows chapter
> headers (small caps, a hairline, a count) followed by `HighlightItem.svelte`
> rows: a date column (`Oct 29` / `2026`, muted), a 3 px left bar in the
> highlight colour, the text (serif, `leading-7`; clamped to 2 lines in compact
> mode with an expand), an attached note in a "NOTE" block rendered with the
> safe markdown renderer, and on the right the format chip and an **Open**
> link to `/read/{book}/{file}?highlight={id}` (hidden when the file is gone or
> not readable). Search matches are highlighted with `<mark>`. Empty states:
> "No highlights yet – highlights you make while reading appear here" and "No
> highlights match these filters" with a clear-filters button.

### BV9.3 – Sidebar and layout

> `HighlightsSidebar.svelte` is a sticky card on `lg` showing: "{n} marks ·
> {c} chapters"; WHEN THEY WERE MARKED (a 52-bar SVG histogram with start and
> end month labels and "Busiest week {date} · {count}"); COLOUR (chips with dot
> and count that toggle the colour filter); WHERE THEY CAME FROM (a stacked
> bar by format with a legend, replacing the screenshot's app sources, which
> are not stored); and CHAPTERS (buttons that scroll to the chapter group,
> each with a stacked colour bar and a count; long names truncate with a
> tooltip). `HighlightsTab.svelte` uses a `1fr 18rem` grid on `lg`, stacked on
> mobile with the sidebar first and collapsible. The list area scrolls with
> the page. Data comes from `getBookState` online, or the synchronized offline
> `readerState` otherwise. Refresh on `BOOK_STATE_CHANGED_EVENT` and when the
> window regains focus.

### BV9.4 – Tests

> `highlights.e2e.ts` (mocked API with 7 highlights across 6 chapters, 2 with
> notes, 4 colours): grouping and counts; search narrows and marks matches;
> the Notes toggle; colour filter from the sidebar chip; the sort change; the
> compact toggle persists after reload; a chapter button scrolls; Export
> requests `/api/v1/me/notes/export?book_ids={id}`; Open goes to
> `?highlight=`; empty book state. Extend `reader.e2e.ts` with one
> `?highlight=` jump case.

## Out of scope

Editing, recolouring or deleting highlights (the reader keeps that),
book-level notes (the Details review), cross-book notes (the Notes page).

## Acceptance criteria

- [ ] Screenshot-8 structure in app style, with "Where they came from" by
      format.
- [ ] Note bodies are rendered through the existing sanitizer only.
- [ ] `?highlight=` jumps in both EPUB (CFI) and PDF readers. Invalid IDs are
      ignored.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/highlights/highlights.e2e.ts src/routes/read/reader.e2e.ts
```

## Hand-off

Set this prompt to Done and update the BV9 row/log.
