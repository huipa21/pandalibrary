# UX2: system and automatic shelves

Decisions behind the UX2 shelf API. The contract is frozen in the
[UX2 prompt](../prompts/UX2-system-smart-shelves.md); the product intent lives in the
[sidebar/dashboard plan](../plans/sidebar-dashboard-plan.md).

## Data model (migration 00002_shelf_modes)

Two independent dimensions describe a shelf:

| Column | Values | Meaning |
|---|---|---|
| `kind` (existing) | `private` / `shared` | Who can see it |
| `mode` (new) | `manual` / `automatic` | How membership is decided |
| `system_key` (new) | NULL / `favorites` | Stable system identity |
| `rules` (new) | NULL / RuleSet JSON | Present exactly when `mode='automatic'` |

CHECK constraints enforce these combinations:

- Automatic shelves are private and have valid JSON rules.
- System shelves are private manual shelves.

A partial unique index `(owner_id, system_key)` allows only one Favorites per account.
`shelves_private_name` now excludes system shelves. A user who already had a custom shelf
named "Favorites" keeps it: it is not renamed or absorbed. The system shelf is
identified only by `system_key`, never by display name.

The migration backfills Favorites for every existing account with `INSERT OR IGNORE`.
Down removes system and automatic shelves, drops the columns, and restores the original
index. Manual shelves and their order survive both directions.

## Favorites provisioning

Accounts created after the migration have no Favorites row yet. The catalog service
creates it lazily in `ensureFavorites`, which runs before `ListShelves`,
`GetSystemShelf(favorites)` and `ListSystemShelfBooks(favorites)`:

1. Look up the row on the read-only pool.
2. If it is missing, run `INSERT OR IGNORE` and a re-read in one write transaction on
   the writer pool.

The unique index makes concurrent first requests converge on one row. Auth code is
untouched, and nothing writes on the reader pool.

## Visibility and privacy

- Other accounts' system shelves are invisible to everyone, including admins, in list,
  get, and membership routes. They return 404, like a missing shelf. Admins still see
  other users' custom private shelves, as before UX2.
- Favorites cannot be renamed, deleted, or have its mode or rules changed (409). Its
  description may be edited. Its `name` is an English default; clients localize by
  `system_key`.
- Every automatic and Unshelved query repeats the catalog visibility predicate: a
  library grant (or admin), and not hidden for the viewer. Counts use the same predicate
  as pages.

## Unshelved

Unshelved is a virtual, read-only view with no database row. For a viewer, it contains the
visible books that are not on any of the viewer's own private, manual, non-system
shelves.

These memberships do not remove a book from Unshelved:

- Favorites
- automatic shelves
- shared shelves, including shelves the viewer created as admin
- other users' shelves

A hidden book on the viewer's own shelf is simply not visible, so it never appears and
is not counted. Unshelved is served only by
`/api/v1/shelves/system/unshelved[/books]`. Those routes are GET-only, so mutations get
404 or 405.

## Automatic rules

A RuleSet is `{"match":"all"|"any","conditions":[...]}` with 1–20 flat conditions:

| field | op | value | Semantics |
|---|---|---|---|
| `title` | `contains` | string, 1–200 chars, not blank, no control chars | Substring of `books.title` using SQLite `instr(lower(..), lower(..))`. It is case-insensitive for ASCII only. `%` and `_` are literal |
| `author_id` | `eq` | positive JSON integer | The book has that author in any role |
| `tag_id` | `eq` | positive JSON integer | The book has that tag |
| `series_id` | `eq` | positive JSON integer | `books.series_id` equals it. A book with no series never matches |
| `language` | `eq` | BCP 47 tag (≤35 chars, `[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*`) | Case-insensitive equality. A NULL language never matches |
| `format` | `eq` | `epub`/`pdf`/`mobi`/`azw3`/`fb2`/`fbz`/`cbz` | The book has any file of that format |
| `reading_status` | `eq` | `unread`/`want_to_read`/`reading`/`finished`/`abandoned` | The viewer's own status. A missing `user_books` row counts as `unread` |

Validation rejects these with 400:

- unknown fields, operators, or JSON keys (including nested rule objects)
- wrong value types; integers as strings, fractions, exponents, signs, or zero
- empty, oversized, or control-character strings
- invalid enums
- more than 20 conditions

Values are canonicalized; for example, `" 1 "` is stored as `1`. Referenced
authors, tags, and series are not checked for existence, so validation cannot reveal
hidden metadata. Such a condition simply matches no visible books.

Rules are evaluated live in one parameterized SQL statement. The statement uses
`json_each` over the stored canonical JSON, and no user text is ever concatenated into SQL.
Import, metadata, and status changes appear on the next read with no rebuild job.
Membership is computed for the reading viewer, so an admin opening another user's
automatic shelf sees results under the admin's own visibility and reading status.

Automatic results and Unshelved are ordered by `(sort_title, id)`. Manual shelves keep
their `(position, …)` order.

## Mutations

| Operation | Result |
|---|---|
| Create without `mode` | Manual shelf, as before UX2 |
| Create `mode:"automatic"` with `kind:"shared"` | 400 `automatic shelves must be private` |
| Create automatic without rules, or manual with rules | 400 |
| PATCH `mode` to a different value | 409. Conversion is not supported, so memberships are never silently discarded |
| PATCH `rules` on a manual or system shelf | 409 |
| PATCH `rules:null` or `mode:null` | 400 |
| PATCH name, mode, or rules on Favorites; DELETE Favorites | 409 |
| PUT/DELETE `/shelves/{id}/books/{bookId}` on an automatic shelf | 409 `automatic shelf membership is computed from its rules` |

## Cursors

All cursors stay opaque and bounded. Each one is bound to a cursor kind, a scope, and a
sort:

| Listing | Scope | Sort | Effect |
|---|---|---|---|
| Shelf list | viewer | `system,name` | System shelves are listed first. Cursors issued before UX2 are rejected with 400; restart from the first page |
| Manual shelf books | Same as before UX2 | Same as before UX2 | Unchanged. Reordering still invalidates the cursor |
| Automatic shelf books | viewer + shelf ID + `automatic` + a 128-bit SHA-256 signature of the canonical rules | `title` | Changing the rules, switching viewer, or switching shelf gives 400 |
| Unshelved books | viewer + `unshelved` | `title` | A cursor cannot be replayed by another viewer or on Favorites |

Favorites books use the numeric manual-shelf cursor.

## OPDS

OPDS uses the same catalog service, so Favorites and automatic shelves appear in
`/opds/shelves` with filtered counts. Their books come from the same live queries.
Unshelved is not exposed in OPDS in this iteration.
