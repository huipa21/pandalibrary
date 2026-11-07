# BV10: Integration, real-server E2E, visual QA, docs and full verification

- Status: Ready
- Wave: 3 (alone). Dependencies merged: BV1-BV9
- Branch/worktree: `task/bv10` / `..\pandalibrary-bv10`
- Migration: no

## Read first

- [Book View plan](../plans/book-view-plan.md) in full, plus every BV hand-off
  log entry in [progress/README.md](../progress/README.md) (deviations,
  duplicated helpers, moved selectors).
- [BH5](./BH5-bookheap-integration.md): the real-server E2E pattern
  (`PANDA_E2E_BINARY`, seeded data, restart check) and the release gate table
  format.
- `web/playwright.config.ts`, `web/src/routes/release.e2e.ts`,
  `web/src/lib/dashboard/dashboard-real.e2e.ts`, `routes/ux-integration.e2e.ts`.

## Goal

Prove that the whole Book View batch works together against the real server.
Remove the seams left by parallel work, finish the docs, and run the **full**
verification suite once. This is the only task in the batch that runs the
full gates.

## Scope

**Owns:** `web/src/routes/bookview-real.e2e.ts` (new), small integration fixes
in any BV-owned file, `docs/architecture/book-view.md` (new),
`docs/architecture/system.md` (UI and route index), `docs/plans/README.md`,
the plan status, `docs/prompts/README.md`, and the progress board/log.

**Rules:** fix real defects found by verification with minimal, targeted
changes in the owning files. Do not redesign. Do not weaken or skip tests.

## Subtasks

### BV10.1 – Consolidate seams

> Replace BV4's local `'pandalibrary-book-state-changed'` constant with the BV3
> `BOOK_STATE_CHANGED_EVENT` import. Deduplicate helpers duplicated by
> parallel tasks (for example `ProgressRing` from BV7/BV8, any local
> `formatSize`) into `web/src/lib/bookview/`. Ensure the legacy
> `catalog.book.cover_unavailable` message and any other now-unused keys are
> removed from both locales. Confirm the en/zh message sets have identical
> `bv*` keys (script or test). Confirm no orphan files (old book page, unused
> placeholders).

### BV10.2 – Real-server E2E

> Add `bookview-real.e2e.ts`, which runs against the built binary like BH5.
> Seed a library with: an EPUB with a cover, an EPUB without a cover and a
> very long CJK title, a PDF without a cover, and a book having both EPUB and
> PDF. Create reading data through the real APIs: reading via `/sync/push`
> sessions with progress (including a re-read so there are two attempts),
> highlights with notes, one shelf membership and a rating. Assert, end to end:
> the generated covers and format badges (`EPUB +1`) on All Books and the
> dashboard; hover Info opens the drawer with real data (collections chip from
> `/books/{id}/shelves`, primary file `original_filename`); Details from the
> drawer goes to the tab page; the Details tab saves a rating and status
> (verified by a reload); the Files tab shows grouping and progress on the
> right file; the Reading Log shows two attempts, deleting a session lowers
> the count and `/api/v1/stats` totals, and Add session adds one; the
> Highlights tab groups by chapter and Open jumps into the reader; prev/next
> walks the All Books list; `/books/{id}/edit` still works for an admin; a
> non-admin cannot see Edit metadata and gets 404 for a hidden book's
> `/shelves`. Include a restart check: after a server restart, the summary and
> sessions are unchanged.

### BV10.3 – Visual and accessibility QA

> Run the app with seeded data and review it with Playwright screenshots at
> 1440×900, 1024×768 and 390×844 for: the All Books grid/list, the dashboard,
> search, the quick view drawer, and each of the four tabs. Compare against the
> user's screenshots 1-8 for structure (not exact pixels) and the app's
> palette. Fix overflow, clipping, contrast or spacing defects. Do an
> accessibility pass on the drawer and each tab using keyboard-only
> navigation and Playwright role/name assertions. Do not add an axe
> dependency. Check that every icon button has a name, focus is visible, and
> the drawer traps and restores focus. Store the screenshots in the session
> workspace, not the repo.

### BV10.4 – Docs

> Write `docs/architecture/book-view.md`: the routes and tab layout, book
> and browse contexts, events, the UI kit inventory, the cover generation
> rules, the attempt derivation, the API endpoints and the offline behaviour
> per tab. Link it from `docs/architecture/system.md`. Mark the plan `Done`,
> update `docs/plans/README.md` (add the Book View row) and
> `docs/prompts/README.md` (statuses), and add the BV10 log entry with the gate
> table.

### BV10.5 – Full verification (run once, after BV10.1-BV10.4)

> Run every gate below and record the results (counts) in the hand-off table.
> If any fails, fix it and rerun **all** of the gates.

## Acceptance criteria

- [ ] The real-server E2E covers every user-visible feature of the request.
- [ ] No duplicated helpers, no unused messages, en/zh parity.
- [ ] Visual review done at three widths with no layout defects.
- [ ] Docs updated. Plan, prompts and progress set to Done.
- [ ] All gates below pass in one final run.

## Validation commands (full gate)

```powershell
task sqlc:check
task lint test build
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
$env:PANDA_E2E_BINARY = (Resolve-Path .\pandalibrary.exe).Path; pnpm --dir web test:e2e
```

## Hand-off

| Gate | Result |
|---|---|
| `task sqlc:check lint test build` | |
| `pnpm --dir web check` | |
| `pnpm --dir web test` | |
| `pnpm --dir web build` | |
| `pnpm --dir web test:e2e` (real server) | |
| Visual QA (3 widths × 8 surfaces) | |

Update the BV10 row and log, and list any follow-ups (for example write-back,
progress strips on cards, or a stored re-reading status).
