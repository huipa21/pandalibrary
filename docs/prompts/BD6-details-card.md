# BD6: Details card with an edit icon and metadata sources

- Status: Ready
- Wave: 1. Dependencies merged: baseline (`d6014b0`)
- Can run in parallel with: BD1, BD2, BD3, BD4, BD5
- Branch/worktree: `task/bd6` in `..\pandalibrary-bd6`
- Migration: no

## Read first

- [Book Detail plan](../plans/book-detail-plan.md): R5, R6, decisions 7-8,
  and the "Details card" contract.
- `web/src/lib/bookview/details/DetailsPanel.svelte` (the "Details" card:
  rows, the library lookup, the date pencils).
- `web/src/lib/bookview/book-context.svelte.ts` (`getBookContext()`,
  `canEditMetadata`, `offline`).
- `web/src/lib/bookview/tabs/DetailsTab.svelte`: **read only**. It shows the
  current "Metadata sources" `<details>` card (`book.field_sources`,
  `catalog.book.provenance`) and the cover-source line under the cover
  (`book.cover_source`, `catalog.book.cover_source`). BD7 deletes both.
- `web/src/lib/catalog/types.ts` (`Book.field_sources`, `cover_source`),
  `routes/books/[id]/edit/+page.svelte` (the W6 metadata editor; check for an
  existing provider/source label helper to reuse).
- `web/src/lib/bookview/details/details.e2e.ts` (Details card assertions).

## Goal

The Details card is where metadata is viewed and edited. It has a pencil at
its top right that opens the metadata editor (admins only), and it shows
where the metadata came from. BD7 then removes the separate card, the cover
line and the Edit metadata button.

## Scope

**Owns:** `DetailsPanel.svelte`, its assertions in `details/details.e2e.ts`
(small hunks), and `bd6.*` messages.

**Must not touch:** `DetailsTab.svelte` (BD7 removes the old card, the cover
line and the button), `book-context.svelte.ts`, and the edit page.

## Subtasks

### BD6.1 – Edit icon

> Turn the heading row into `flex items-center justify-between`. When
> `canEdit && !offline`, add an icon link at the right: `Icon name="pencil"`
> (`size-4`) in a `size-8` round hit area with `hover:bg-slate-100` and an
> emerald focus ring, `href="/books/{id}/edit"`. Its `aria-label` and `title`
> are `bd6.edit_metadata` ("Edit metadata" / "编辑元数据"). `canEdit` is an
> optional prop. When it is omitted, use `getBookContext().canEditMetadata`,
> so the icon works on the live tab without changing `DetailsTab`. The
> component is only used inside the book context.

### BD6.2 – Metadata source rows

> After the "Added" row and before the date rows, add:
> - **Metadata source** (`bd6.metadata_source`): the distinct
>   `book.field_sources[].source` values in first-seen order, joined with
>   ", ", or `–`. When there is at least one source, add a
>   `<details>`/`<summary>` "Show fields" (`bd6.show_fields`) under the
>   value. It lists `field: source · source_ref` (the same format as the old
>   card, `[overflow-wrap:anywhere]`, `text-xs`). Reuse a provider-label
>   helper if the edit page has one; otherwise show the raw source.
> - **Cover source** (`bd6.cover_source`), only when `book.cover_source` is
>   set.
>
> Use the existing `grid-cols-[7rem_minmax(0,1fr)]` row layout.

### BD6.3 – Tests

> In `details.e2e.ts`:
> - an admin sees the pencil with the accessible name "Edit metadata", and it
>   navigates to `/books/{id}/edit`;
> - a reader does not see it;
> - offline hides it;
> - the Metadata source row lists the distinct sources, and "Show fields"
>   expands the per-field list;
> - the Cover source row appears only when set;
> - with no field sources, the row shows `–`.
>
> (The old Metadata sources card still exists until BD7. Scope your locators
> to the Details card region `aria-labelledby="book-details-heading"`.)

## Acceptance criteria

- [ ] R5: an admin can open the metadata editor from the Details card's top
      right icon. It is hidden for non-admins and offline.
- [ ] R6: the metadata and cover sources are visible inside the Details card.
- [ ] The date pencils still work. Targeted tests pass.

## Validation commands (targeted only)

```powershell
pnpm --dir web check
pnpm --dir web exec playwright test src/lib/bookview/details/details.e2e.ts
```

## Hand-off

Set this prompt to Done, update the BD6 row/log in
[progress/README.md](../progress/README.md), and tell BD7 which old elements
in `DetailsTab` are now redundant (the provenance card and the cover-source
line).
