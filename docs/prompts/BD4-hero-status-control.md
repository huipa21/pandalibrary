# BD4: Hero cleanup and borderless status control

- Status: Done
- Wave: 1. Dependencies merged: baseline (`d6014b0`)
- Can run in parallel with: BD1, BD2, BD3, BD5, BD6
- Branch/worktree: `task/bd4` in `..\pandalibrary-bd4`
- Migration: no

## Read first

- [Book Detail plan](../plans/book-detail-plan.md): R7, R8, R9 and decision 9.
  Reference screenshot: [book-detail-before.png](../plans/assets/book-detail-before.png).
  The bordered white "Unread ⌄" pill and the "Personal review" link are next
  to the stars, and the red "PDF" chip is under them.
- `web/src/lib/bookview/details/DetailsHero.svelte` (status menu, the
  offline read-only span, the `#book-review` link, the `formats` chips next
  to `IdentifierLinks`).
- `web/src/lib/bookview/ReadStatusMenu.svelte`: the variants `pill` (also used
  by `log/LogSummary.svelte`), `icon` (quick view and the Resume row) and
  `badge` (cover tiles); the keyboard model, optimistic update and error
  line.
- `StatusIcon.svelte`, `statusTone()` and `readStatusLabel()` in `user-book.ts`.
- `web/src/lib/bookview/details/details.e2e.ts` (hero assertions) and
  `kit-fixture.svelte` (a visual playground, if useful).

## Goal

The hero row reads: stars, then a quiet status control ("● Reading ⌄") with
no border or chip background. The format chip under the title and the
"Personal review" link are gone.

## Scope

**Owns:** `DetailsHero.svelte`, `ReadStatusMenu.svelte` (add the `inline`
variant only; do not change the others), the hero assertions in
`details/details.e2e.ts` (small hunks), and `bd4.*` messages.

**Must not touch:** `DetailsTab.svelte` (BD7), `user-book.ts` (BD2),
`LogSummary.svelte`, and the quick-view and tile call sites.

## Subtasks

### BD4.1 – `inline` variant

> Add `variant: 'inline'` to `ReadStatusMenu`. The trigger is
> `inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium
> text-slate-800 bg-transparent hover:bg-slate-900/5` with an emerald
> `focus-visible` outline. It has **no border, ring or shadow**. It contains
> `StatusIcon` (`size-4`, tone colour), `readStatusLabel(selected)` and
> `Icon name="chevron-down"` (`size-4 text-slate-500`, rotated 180° while
> open, without a transition under reduced motion). The accessible name is
> the existing `bv3.status_menu_current`. The menu panel, positioning,
> keyboard model and error line are the same as `pill` (opens below-left,
> flips/clamps like `pill`). In dark mode, check that the app palette remap
> keeps the contrast (use slate tokens only).

### BD4.2 – Hero changes

> In `DetailsHero.svelte`:
> - use `<ReadStatusMenu variant="inline">`;
> - replace the offline read-only bordered span with the same visual without
>   the chevron, non-interactive: `StatusIcon` + label,
>   `aria-label={readStatusLabel(…)}`;
> - **remove** the "Personal review" link (`bv6.personal_review`);
> - **remove** the format chips (`formats`, `formatTone`, `sortedFormats`
>   imports if unused), but keep `IdentifierLinks variant="chips"` (show its
>   wrapper only when identifiers exist).
>
> Leave the message keys in place (BD8 prunes them).

### BD4.3 – Tests

> Update the `details.e2e.ts` hero assertions that these removals break.
> Add: there is no `PDF`/`EPUB` format chip in the hero (the cover badge
> still shows it); there is no "Personal review" link; the status trigger has
> a computed `border-top-width` of `0px` and a transparent background at
> rest; the trigger opens the menu with Enter/ArrowDown; choosing "Reading"
> updates the label optimistically; the offline view has no chevron and no
> button.

## Acceptance criteria

- [x] R7, R8, R9 are visible on the Details tab at 360/768/1440 px. The
      stars and the status share one baseline.
- [x] `pill`, `icon` and `badge` render exactly as before (LogSummary, quick
      view and tiles are unchanged).
- [x] Targeted tests pass.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/details/details.e2e.ts src/lib/bookview/quickview/quickview.e2e.ts src/lib/bookview/covers.e2e.ts
```

## Hand-off

Set this prompt to Done, update the BD4 row/log in
[progress/README.md](../progress/README.md), and attach before/after
screenshots of the hero row.

### Completed 2026-11-08

- Added the hero-only `inline` variant, retaining the existing accessible
  name, keyboard handling, optimistic update and error line. Its menu reuses
  the badge's viewport positioning helper for flipping/clamping; the other
  variants keep their existing appearance and behavior.
- Removed the hero format chips and review link, kept identifier links,
  aligned the rating/status icons, and made the offline status a borderless,
  non-interactive icon and label without a chevron. Message keys remain.
- Verified light/dark layouts at 360, 768 and 1440 px, keyboard opening,
  reduced motion, optimistic selection, menu bounds and offline rendering.
- Validation: Svelte/TypeScript check has zero errors/warnings; 201 bookview
  unit tests and all 42 targeted Details/quick-view/cover E2E tests pass.
  Production build passes. Browser tests used a session-local configuration
  and localhost static server on port 4185 to avoid concurrent preview/build
  interference in the shared checkout.
- Hero screenshots: [before](../plans/assets/book-detail-bd4-before.png),
  [after](../plans/assets/book-detail-bd4-after.png). The E2E visual test also
  attaches all six light/dark viewport screenshots.
