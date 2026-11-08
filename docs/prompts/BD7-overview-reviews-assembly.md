# BD7: Overview and Reviews cards, Details tab assembly and removals

- Status: Done
- Wave: 2 (alone). Dependencies merged: BD3, BD4, BD5, BD6 (BD1 and BD2
  recommended; not required)
- Can run in parallel with: none (it owns `DetailsTab.svelte`)
- Branch/worktree: `task/bd7` in `..\pandalibrary-bd7`
- Migration: no

## Read first

- [Book Detail plan](../plans/book-detail-plan.md): R1-R3, R5, R6, R11-R13,
  decisions 5-6 and 11-13, and all the contracts. Reference screenshot:
  [book-detail-before.png](../plans/assets/book-detail-before.png).
- The BD3-BD6 hand-offs in [progress/README.md](../progress/README.md):
  the reviews JSON/client, the shelf store API, the details card and hero
  changes.
- `web/src/lib/bookview/tabs/DetailsTab.svelte` (all of it),
  `details/SynopsisCard.svelte`, `details/ReviewEditor.svelte`,
  `details/ReadingCard.svelte`, `details/details-data.ts` (+ test:
  `review`/`latestReview`/`saveReview`), `shelves/AddToShelf.svelte` (only
  used by DetailsTab), `bookview/reviews-api.ts` (BD3),
  `details/book-shelves.svelte.ts` and `BookShelfTags.svelte` (BD5),
  `quickview/ShelfPopover.svelte` (`variant="button"`, `placement="down"`).
- `ExpandableText.svelte`, `format.ts` (`formatRelative`), `Icon.svelte`
  (`plus`, `pencil`, `trash`).
- `details/details.e2e.ts` (now owned by you; BD4/BD6 changed a few hunks).

## Goal

The Details tab matches the request: a clean left column (cover, Resume, the
icon status menu, Download, the Add to shelf popover, shelf tags); a centre
column with the hero, the **Overview** card and the **Reviews** card; and a
right column with the Details card (edit icon and sources), Editions and
Identifiers. Everything the user asked to remove is gone.

## Scope

**Owns:** `tabs/DetailsTab.svelte`, `details/OverviewCard.svelte` (rename of
`SynopsisCard.svelte`), `details/ReviewsCard.svelte` (new),
`details/ReviewEditor.svelte`, deleting `details/ReadingCard.svelte` and
`shelves/AddToShelf.svelte`, `details/details-data.ts` (+ test),
`details/details.e2e.ts`, a new `details/reviews.e2e.ts`, and `bd7.*`
messages.

**Must not touch:** `DetailsHero` (BD4), `DetailsPanel` (BD6), the shelf
store/tags (BD5; report bugs in the log or fix them minimally with a note),
server code, and `BookTabs` (BD1).

## Subtasks

### BD7.1 – Overview card

> Rename `SynopsisCard.svelte` → `OverviewCard.svelte` with props
> `{ description: string | null }`. The heading is `bd7.overview`
> ("Overview" / "简介"). The empty text is `bd7.no_overview` ("No overview is
> available." / "暂无简介。"). It keeps `ExpandableText lines={6}` and has
> **no review section**. Keep `aria-labelledby` with a new id
> `book-overview-heading`.

### BD7.2 – Reviews card

> `ReviewsCard.svelte` `{ bookId, offline, isAdmin }`. It is a `card p-5
> sm:p-6` section under Overview:
> - **Header:** "Reviews" (`bd7.reviews`, uppercase xs heading like the
>   other cards) and the `total` count in muted text. On the right, a
>   `size-8` round **Plus** icon button (`Icon name="plus"`, accessible name
>   `bd7.write_review` "Write a review"). It is shown only when online,
>   loaded, the viewer has no review and the editor is closed.
> - **Editor:** adapt `ReviewEditor.svelte` to the API. It gets `{ bookId,
>   initial: string, onSaved(review), onCancel }`, calls `saveMyReview`, and
>   keeps the textarea (10,000 max), the character count, Save/Cancel, busy
>   state and error alert. The `SyncError` "stale" branch is gone. Map
>   `ApiError` 400 to a validation message and other errors to
>   `bv6.review_error`. Opening it focuses the textarea. Cancel restores
>   focus to the trigger.
> - **List:** my review is pinned first ("You" chip). Each review is an
>   `<article>` with the author name, a relative date (`<time datetime>`),
>   "· edited" when `updated_at > created_at`, and the body as
>   `whitespace-pre-wrap [overflow-wrap:anywhere]` inside `ExpandableText`
>   (8 lines). My review has pencil (edit) and trash (delete) icon buttons.
>   Admins see a trash button on others' reviews too. Delete asks for
>   confirmation (`window.confirm(m['bd7.delete_review_confirm']())`) and
>   then calls `deleteMyReview` or `deleteReview`.
> - **Paging:** a "Show more" button when `next_cursor` is set. It appends
>   the next page and de-duplicates by id.
> - **States:** loading (muted `role="status"`); error with Retry; empty
>   "No reviews yet." (`bd7.no_reviews`, plus "Be the first to write one."
>   when the Plus button is available); offline `bd7.reviews_offline`
>   ("Reviews are available when you're online.").
> - **Reloading:** reload on `bookId` change with an `AbortController`
>   (suppress stale responses), and after save/delete (update the list
>   locally, then refetch the first page quietly to refresh `total`).

### BD7.3 – Data cleanup

> In `details-data.ts`, remove `review` from `DetailsState`, along with
> `latestReview` and `saveReview` (book-level notes stay private, in Notes
> and the reader). Keep `summary` only if something still uses it after the
> `ReadingCard` deletion; otherwise stop loading it (`getReadingSummary`) to
> save a request. Update `details-data.test.ts`.

### BD7.4 – DetailsTab assembly

> In `DetailsTab.svelte`:
> - **Left aside:** cover; Resume row (unchanged, the icon status menu is
>   kept); the error line; then, when online, a row with Download and
>   `<ShelfPopover bookId variant="button" placement="down"
>   memberIds={shelves.memberIds} />` (replacing the `#book-shelf` anchor);
>   then `<BookShelfTags {shelves} bookTitle={book.title} offline={offline}
>   />`. **Remove:** the cover-source line, the **Edit metadata** button and
>   the **Back to library** link. Create the store with
>   `const shelves = createBookShelves(() => bookId)`. Offline: no
>   Download/Add, read-only tags (or hide the tags when the store errors
>   offline).
> - **Centre:** `DetailsHero`, `<OverviewCard description={book.description} />`,
>   `<ReviewsCard bookId={book.id} {offline} isAdmin={context.canEditMetadata} />`.
>   **Remove** `ReadingCard` (delete the file).
> - **Right aside:** `DetailsPanel` (BD6; it reads `canEditMetadata` from the
>   context), `EditionsCard`, the Identifiers card. **Remove** the
>   "Metadata sources" `<details>` card.
> - **Bottom:** remove the `#book-shelf` `AddToShelf` section. Delete
>   `shelves/AddToShelf.svelte` if `rg -n AddToShelf web/src` finds no other
>   user.
>
> Keep the grid breakpoints. Check that no column collapses at 768 px.

### BD7.5 – Tests

> In `details.e2e.ts` (and a new `reviews.e2e.ts` with mocked routes):
> - **Absent:** the Shelves form/select, "Back to library", the "Edit
>   metadata" button under the cover, "Metadata sources" card, "Your
>   reading", "Synopsis", "Personal review" and the format chip under the
>   title.
> - **Present:** "Overview", the Reviews card, shelf tags, and Add to shelf
>   opening the popover downward.
> - **Shelves:** move/execute the BD5 hand-off cases on the real tab.
> - **Reviews:**
>   - Plus → write → Save shows my pinned review, and Plus disappears;
>   - edit keeps `created_at` and shows "edited";
>   - delete → confirm restores Plus;
>   - other users' reviews are listed newest first with "Show more";
>   - an admin can delete another user's review, and a reader cannot;
>   - offline shows the online-only message;
>   - a 400 shows the validation message;
>   - switching books aborts and does not mix lists.
> - **Layout:** no horizontal scroll at 360 px.

## Acceptance criteria

- [ ] R1-R3, R5, R6, R11-R13 hold on the Details tab (en/zh, 360/768/1440
      px).
- [ ] Reviews show all users' reviews. Plus writes my own. Notes are no
      longer shown as a review.
- [ ] No dead code: `ReadingCard`, `AddToShelf` (if unused) and `SynopsisCard`
      are removed. `rg -n "SynopsisCard|ReadingCard|book-shelf|latestReview" web/src`
      finds nothing.
- [ ] Targeted tests pass.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec vitest run src/lib/bookview
pnpm --dir web exec playwright test src/lib/bookview/details src/lib/bookview/details-shell.e2e.ts src/lib/bookview/quickview/quickview.e2e.ts
```

## Hand-off

Set this prompt to Done, update the BD7 row/log in
[progress/README.md](../progress/README.md), list the message keys that are
now unused (for BD8 to prune), and attach 1440/768/360 screenshots of the
Details tab.

Done (2026-11-09):

- Screenshots: [1440](../plans/assets/book-detail-bd7-1440.png),
  [768](../plans/assets/book-detail-bd7-768.png),
  [360](../plans/assets/book-detail-bd7-360.png).
- Message keys now unused in `web/src` (BD8 prunes): `bv6.synopsis`,
  `bv6.no_synopsis`, `bv6.personal_review`, `bv6.review_empty`,
  `bv6.review_write`, `bv6.review_edit`, `bv6.review_conflict`,
  `bv6.state_loading`, `bv6.reading`, `bv6.last_read`, `bv6.sessions`,
  `bv6.time`, `bv6.average`, `bv6.no_sessions`, `bv6.chart_summary`,
  `bv6.reached`, `bv6.source_web`, `bv6.source_koreader`,
  `bv6.sessions_error`, `bv6.open_log`, `catalog.back_to_library`,
  `catalog.book.provenance`, `catalog.book.cover_source`,
  `shelves.book.heading`, `shelves.book.select`, `shelves.book.choose`,
  `metadata.edit.link`.
- Removed `ReadingCard.svelte` and `shelves/AddToShelf.svelte` (no other
  users). `search-shelves.e2e.ts` now adds via the Details-tab popover.
- `menu-layout.e2e.ts` "accessible titles" fails on the baseline too
  (header Settings link on `/settings`); left for BD8.

BD8 completion (2026-11-09): the stale header assertion now uses Account
menu → Profile. The full real-server-enabled suite passes all 221 tests;
the integration hand-off includes final screenshots and documentation.
