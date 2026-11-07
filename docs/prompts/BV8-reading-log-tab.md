# BV8: Reading Log tab

- Status: Ready
- Wave: 2. Dependencies merged: BV2, BV3, BV4
- Can run in parallel with: BV5, BV6, BV7, BV9
- Branch/worktree: `task/bv8` / `..\pandalibrary-bv8`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md): decisions 9, 10 and 11, the
  BV2 contract (`summary`, `Session`), the UI kit, the book context.
- The BV2, BV3 and BV4 hand-offs in [progress/README.md](../progress/README.md).
- `web/src/lib/bookview/log-api.ts` (BV2), `web/src/lib/bookview/tabs/ReadingLogTab.svelte`
  (placeholder), `web/src/lib/stats/BarChart.svelte` and
  `web/src/routes/stats/+page.svelte` (existing SVG chart conventions),
  `web/src/lib/paging/CursorPager.svelte.ts`, `web/src/lib/reader/api.ts`
  (`getBookState`).
- Screenshot 7 has three columns. Left: a progress ring with the status
  dropdown and "~5m to finish", then Started, Finished, Total time, Sessions,
  Average session, Active days `108 of 170`, Pace and Last read, with **+ Add
  session** at the bottom. Middle: a **Sessions** table ("Showing 25 of 196")
  with All time / 30 days / 90 days / This year and Export, columns Day, Time,
  Length, Change (green +/orange −), Position in book (a bar from start to
  end), Reached and Source, a trash icon, "Attempt N began" divider rows, and
  Load more. Right: an **Attempts** timeline and a **Records** card. Bottom:
  **Progress over time** (a line of position reached plus bars of minutes per
  day) with a Curve/Trace toggle.

## Goal

The Reading Log tab gives a complete per-book reading history: a summary,
filterable sessions with add/delete/export, derived attempts, records and a
progress-over-time chart.

## Scope

**Owns:** `web/src/lib/bookview/tabs/ReadingLogTab.svelte`,
`web/src/lib/bookview/log/**` (new: `LogSummary.svelte`, `SessionsTable.svelte`,
`AddSessionDialog.svelte`, `AttemptsCard.svelte`, `RecordsCard.svelte`,
`ProgressChart.svelte`, `log-model.ts` + tests, `log.e2e.ts`), and `bv8.*`
messages.

**Must not touch:** `log-api.ts` (BV2; report needed changes), other tabs,
the kit internals, backend.

## Subtasks

### BV8.1 – Model helpers

> Create `log-model.ts`. `groupSessionsByDay(sessions, timezone)` returns day
> groups, using the local day label (`Nov 6 Fri`) only on a group's first row.
> `attemptDividers(sessions)` inserts an "Attempt N began · date" marker where
> `attempt` changes between consecutive rows (newest-first order).
> `changeTone(change)` returns positive, negative or neutral. `sessionsToCsv(sessions)`
> returns RFC 4180 CSV with the columns started_at, ended_at, active_seconds,
> start_percentage, end_percentage, change, source, device and attempt.
> `chartSeries(days, mode)` returns, for `curve`, a smoothed polyline (monotone
> cubic) and, for `trace`, a step line, plus minute bars and axis ticks (max 8
> date labels, a 0-100% left axis and a minutes right axis). Unit-test each,
> including DST days, an empty input and negative changes.

### BV8.2 – Summary column

> `LogSummary.svelte` is a card with a `ProgressRing` (reuse it from BV7 only if
> merged, otherwise a local copy; BV10 dedupes) showing `progress`,
> `ReadStatusMenu variant="pill"` (`reread` when there is more than one
> attempt), and "~{estimate} to finish" when `estimated_seconds_left` is set.
> Below, a `<dl>` with Started/Finished (from user_book, else "Not set"),
> Total time, Sessions, Average session, Active days `a of span`, Pace
> (`x%/h`) and Last read (relative). At the bottom, a full-width emerald **+ Add
> session** button opening `AddSessionDialog`.
> `AddSessionDialog.svelte` is a modal (focus trap/restore, Escape) with Date
> (default today), Start time, Duration (minutes, 1-1440), Start % and End %
> (0-100, optional, end ≥ 0) and validation messages. Save calls
> `addManualSession` and then `notifyBookStateChanged`, refreshes the
> summary, sessions and chart, and closes. A `SyncError` shows inline.

### BV8.3 – Sessions table

> `SessionsTable.svelte` is a card with the header "SESSIONS · Showing {n} of
> {total}", a segmented range control (All time / Last 30 days / Last 90 days /
> This year → `all|30d|90d|year`, URL-synced as `?range=`), and an **Export**
> button. Export pages through every session for the current range (cap 10,000)
> and downloads `"{title} reading log.csv"`. The table is semantic
> (`<table>`, sticky header, scrolls in a max-height container) with the columns
> Day, Time, Length, Change (emerald for +, amber for −, signed %), Position in
> book (a 100 px track with an emerald segment from start to end and an amber
> segment for a backward jump), Reached (%), Source (format-like chip `WEB` /
> `KOREADER` with the device in the tooltip) and a delete icon button (accessible
> name "Delete session from {date time}", with a confirm dialog that calls
> `deleteBookSession`, removes the row optimistically, rolls back on error, and
> then notifies). Attempt dividers render as full-width tinted rows. **Load
> more** uses `CursorPager` (25 per page). Loading, empty ("No sessions in this
> range") and error/retry states are explicit.

### BV8.4 – Attempts, records, chart, layout

> `AttemptsCard.svelte` shows "ATTEMPTS N" and a vertical timeline (newest
> first): a dot (emerald for completed, ring for in progress, slate for
> stopped), "Attempt N · Completed/In progress/Stopped", source chips, the date
> range, sessions and duration. It scrolls when long and ends with a link "See
> all reading in Stats" to `/stats`. `RecordsCard.svelte` has rows for Longest
> session (with date), Best day (with date), Longest streak (days) and Reading
> pace. `ProgressChart.svelte` is a full-width card "PROGRESS OVER TIME · {active}
> active days across {span}", with a legend and a Curve/Trace segmented toggle.
> The responsive SVG is drawn from `chartSeries` (`viewBox`, resizes with the
> container), has a hover/focus tooltip per day (date, minutes, reached %) and
> uses `role="img"` with a text summary. `ReadingLogTab.svelte` lays these out:
> 3 columns on `xl` (`18rem 1fr 18rem`), 2 on `lg` (attempts and records drop
> below), stacked on mobile, with the chart at the bottom. Data comes from
> `getReadingSummary` and `listBookSessions` with `viewerTimezone()`. Offline,
> it shows a muted "Reading log needs a connection" panel with retry. Refresh on
> `BOOK_STATE_CHANGED_EVENT`.

### BV8.5 – Tests

> `log.e2e.ts` (mocked API): the summary values render; switching range
> refetches with `range=30d` and updates "Showing"; Load more appends;
> attempt dividers appear; delete with confirm sends DELETE and the row
> disappears; a delete failure restores the row; Add session validates, then
> pushes one `reading_sessions` mutation with `device: 'Manual entry'`; Export
> downloads CSV with a header row; the Curve/Trace toggle changes the path;
> the empty book shows empty states; 390 px has no horizontal page overflow
> (the table may scroll inside its card).

## Out of scope

Editing sessions, a stored attempts model, cross-book history (Stats page).

## Acceptance criteria

- [ ] Screenshot-7 structure in app style with all listed interactions.
- [ ] Day grouping and chart dates use the viewer's timezone.
- [ ] The table and chart are accessible (table semantics, chart text
      alternative, labelled icon buttons).

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/log/log.e2e.ts
```

## Hand-off

Set this prompt to Done and update the BV8 row/log. Note any duplicated
helper (for example `ProgressRing`) for BV10 to consolidate.
