# Using PandaLibrary

## Signing in and layout

Sign in with the account your administrator gave you. The header holds the
search box, language, theme (light or dark) and your account menu. Search is
only in the header; the sidebar has no Search entry. The sidebar holds
navigation, libraries and collections; on small screens it opens as a drawer from the
menu button. Select the PandaLibrary logo to return to the dashboard.

The header, sidebar and main content keep the same width and position when
switching between pages with and without a vertical scrollbar.

## Administration

Administrators open **Admin** to manage **Users**. There is no Overview tab.
Server CLI account commands are listed at the bottom of Users.

Choose a search category, enter text, and select **Search accounts** to search
all accounts, not just the loaded rows. An empty search shows all accounts.
The **#** column numbers the displayed rows; it is not the account ID.
Select individual checkboxes or use the header checkbox to select or clear all
loaded users. Loading more rows does not select them automatically.

Actions appear above the table when users are selected. **Edit** and
**Reset password** require one selected account. **Enable**, **Disable**,
**Revoke credentials**, and **Delete** support multiple accounts; Enable and
Disable apply only to accounts that need the change. Destructive operations
require confirmation. Bulk operations stop on the first failure and report
how many accounts were changed; completed changes are not rolled back.

**Uploads** handles book uploads and their processing history. **Backup**
creates and saves a single database-and-media `.tar.gz` archive on the server.
Download archives for safekeeping, or restore from a saved or uploaded archive.
Restores are validated and staged first: restart the server to replace all
application data. The executable and deployment configuration are not replaced.
Before reconnecting, clear offline data on every client so old queued changes
cannot overwrite the restored state. Backup-era passwords, sessions and device
credentials return, including credentials revoked after the backup was created.

## Dashboard

The dashboard is your home page. It shows reading feeds such as Continue
Reading, Recently Added and Read, plus any collections you add.

To change it, use the **⋮** button next to **Dashboard** in the sidebar. You can
add, remove and reorder sections, add a collection as a section, or save an empty
dashboard. The layout is saved to your account.

## Browsing books

Library, collection, author, series and tag pages list the books you can see.
The computed **All Books** page remains available at `/books`, but is no
longer a sidebar menu item. You can:

- switch between grid and list view with the view button;
- filter by author, series or tag and change the sort order;
- clear filters with the clear-filters button.

Use the settings gear in a library or collection's content toolbar to adjust
cover size and spacing. Both use the same controls. Settings are saved on this
device separately for each library and collection.

Books without a cover automatically get a generated default cover showing the
title and authors, whatever the book's format. There is nothing to run: once a
real cover is added — from the book file, an upload or a metadata provider — it
replaces the default cover. Badges show each book's formats and your reading
status.

### Libraries

The **Libraries** heading and its arrow expand or collapse the complete list
of available libraries; the **⋮** actions stay visible when collapsed. Select
a library to browse only its books. **Manage Libraries** opens the library
cards, each showing its visible book count.

Every catalog book belongs to exactly one library. A library is its physical
ownership boundary, while a collection is a logical grouping that can span
libraries. Adding a book to a collection never copies or moves it.

Use the **⋮** beside the library heading for **New Library**, **Edit Library**
(the selected library's settings), or **Manage Libraries**. Creating, editing,
and deleting libraries requires an administrator account. Administrators also
have edit and delete icons at the bottom right of each library card. Deletion
requires confirmation; only empty, non-default libraries can be deleted.
Readers can use **Manage Libraries** to return to the library cards.

## Book pages

Opening a book shows four tabs:

| Tab | What it shows |
|---|---|
| **Details** | Description and metadata, your reading status and rating, collections, and reviews |
| **Files** | The book's files. Read, download or save a file for offline reading |
| **Activities** | Your reading progress, reading sessions and summary. You can add a session by hand |
| **Annotations** | Your reviews, comments, private notes, highlights, underlines, strikeouts, inserted text, drawings and images for this book only |

Reading statuses: Unread, Want to read, Reading, Re-reading, On hold, Read,
Skimmed and Abandoned.

Change your reading status beside the rating in the book header. Below the
cover, the full-width **Read** or **Resume** button opens the reader. The icons
under it download the book, toggle Favorites with the star beside Download, and
add it to a collection. These borderless icons show a shaded square on hover. If you uploaded the book, a
visibility control directly below **Read** or **Resume** shows its current
state and lets you make it private or public after confirmation: private means
only you can see it, while public means any signed-in user can see it, not
anonymous visitors. Books without a recorded uploader, such as older books
and folder imports, keep library-based access and do not show this control.

The book's **Library** is shown below **Collections**. Tags remain above the overview,
separate from the metadata card. Publication dates show only the date; file sizes
and added dates are in **Files**, and reading dates are in **Activities**.
Technical UUID identifiers are hidden on **Details** but remain stored.

Administrators can select **Edit metadata** (the pencil in the **Details** card)
to edit the existing metadata in one form, including adding, renaming or removing
tags. Select **Save metadata** at the bottom to save all changes. Direct edits do
not require looking up metadata candidates. **Find metadata** at the top right
adds source tabs and a side-by-side comparison; use the buttons between each
row's values to copy a found value or restore the saved value before saving.
See [editing book metadata](./administration.md#editing-book-metadata) for
combining results from different sources.

- **Unread** and **Want to read** are only for books you have not started.
  Saving positive reading progress automatically starts **Reading**. After
  starting, a book cannot return to either untouched status.
- **Reading** and **Re-reading** can be paused with **On hold**. Saving reading
  progress resumes the paused cycle. Active reading reaches **Read** automatically
  at 99% progress.
- **Read**, **Skimmed** and **Abandoned** end the current cycle and can switch
  directly between one another without adding another cycle. Marking **Read** or
  **Skimmed** sets progress to 100%; **Abandoned** keeps the saved position.
  Reading an ended cycle does not change its status automatically. Opening a
  **Read** or **Skimmed** book again saves your position so you can resume, but
  its progress stays at 100%. That reading time still counts toward your total
  time, sessions, active days and streaks. It doesn't change the finish date,
  the number of finished books or the reading pace, and the remaining-time
  estimate shows **Completed**. To resume an
  abandoned cycle and allow automatic completion, manually choose **Reading**.
- From any ended status, **Re-reading** archives that cycle and resets progress
  and the saved reading position to zero. Activities retains the previous
  cycle as **Read once**, including its final status, and starts the next cycle
  even before a reading session is recorded. Monthly stats count ended cycles
  (Read, Skimmed and Abandoned), not just unique books. Re-reading does not erase
  earlier cycles. The dashboard keeps previous Read/Skimmed cycles in **Read**
  and shows the new cycle in **Continue reading**, including at 0%.

**Reviews are public; notes and comments are private.** Anyone who can see a
book can read its reviews. Your passage comments, book notes and highlights
are only visible to you.

The back button returns to the list you came from. The **‹ ›** buttons, or the
`[` and `]` keys, move to the previous or next book in that list.

## Reader

Choose **Read** or **Resume** on a book to open it in the browser. Your
position is saved automatically and syncs across your devices.

All supported formats share a full-screen reader with a compact toolbar, reading
progress, sync status, close button and left sidebar. The app header and library
sidebar are hidden while reading. The reader sidebar docks on wide screens and
overlays the book on smaller screens.

In EPUB, MOBI, AZW3, FB2, FBZ and CBZ readers you can:

- use **Contents** to jump to a chapter when the book provides a contents list;
- use **Zoom** to choose **Automatic**, **Actual size**, **Fit page**,
  or **Page width**. Use the minus/plus controls for manual zoom adjustments
  under **Automatic**, without choosing a preset percentage;
- open **Page display** to choose **Single page**, **Single page continuous**,
  **Split** or **Split continuous**;
- open **Format** to change ebook fonts, spacing and backgrounds. Changes save
  automatically for your account and this book, without affecting other books
  or readers. In CBZ comics, **Format** offers backgrounds without text controls;
- use **Rotate** to turn the view left or right. In these non-PDF formats,
  rotation lasts only for the current reader session and is not saved;
- open the **+** button to choose **Text**, **Draw** or **Image**, then click
  the place in the book where you want to add the item. The dropdown opens
  directly beneath the button in every reader;
- select text in EPUB, MOBI, AZW3, FB2 or FBZ to open the floating annotation
  toolbar: copy, highlight, underline, strike out, attach a comment or bookmark
  the passage. Use the colour arrows to choose highlight and line colours;
- open **Annotations** to review saved marks, change their colours, attach or
  edit notes, or delete them. In CBZ comics, use **Highlight current page** to mark
  the current page from the top toolbar instead of selecting text;
- use the bookmark icon in the top toolbar to add or remove a bookmark for the
  current page, and open **Bookmarks** to review saved positions;
- use the previous/next buttons, arrow keys or position slider to navigate.

On narrow screens, these view menus move into **More view options**, like PDF
view menus. **Select** and **Hand** are PDF-only tools; ebooks use text selection
directly. The **+** insertion menu is shared by every reader.
Ebook zoom changes the page view independently of the font size in **Format**.
Continuous layouts let you scroll between pages; split layouts show pairs of
pages.

For EPUB, MOBI, AZW3, FB2, FBZ and PDF, open the magnifying-glass **Search**
tab in the left rail to search the book's text. Enter a query and press Enter.
Results show matching passages with highlighted search terms; select a result
to jump to that passage. Results are paginated, with 20 matches per page.
Use the previous/next match controls to move between occurrences, including
across result pages. Clear the search to remove its highlights.
Search runs locally in your browser and also works for downloaded books offline.
CBZ comics have no text search. PDF search uses the document's embedded text,
not the separately recognized text on scanned pages.

Reading time is recorded as sessions for your stats; idle time is not counted.

PDFs fill the screen below a compact toolbar, without the app header or
library sidebar. Progress shows two decimal places (for example, **10.05%**), while
saved positions retain the page and your scroll position within it. Type a page
number in the counter to jump there. Use Zoom, Page display, Format and Rotate to
adjust the view; below 640 px these menus are inside **More view options**.
New books start in continuous mode with Automatic zoom unless you have saved
a different PDF default.

Some PDFs contain invalid embedded TrueType font hinting (`TT: undefined
function`). The PDF renderer discards these invalid instructions automatically.
The reader quiets recoverable PDF diagnostics while still
reporting load and rendering failures; the original PDF is not modified.

**Page display** contains four layouts and the scanned-text recognition switch.
Split layouts pair pages 1–2, 3–4, and so on; there is no separate-cover option.
**Format**, immediately to its right, offers ten page backgrounds: White,
Cream, Sepia, Eye-care green, Wood, Gray, Sky, Blush, Night and Black. PDF font
controls are unavailable because PDF text cannot reflow. Night and Black
invert the page, including images, while light backgrounds tint the paper
without changing the ink. Old Dark settings open as Night.

View changes save automatically after one second. Layout, background and zoom
presets also become defaults for other PDFs; rotation and free
numeric zoom apply only to the current book. Ctrl/Command plus the mouse wheel,
trackpad pinch and two-finger touch pinch zoom around the pointer or midpoint.
One-finger touch scrolling stays native.

Use the arrow keys, Page Up/Down, or Space/Shift+Space to turn pages (or scroll
one viewport in continuous mode). Home/End jump to the first/last page.
Ctrl/Command `+`, `-`, and `0` zoom in, out, and Automatic. `R`/Shift+`R`
rotate right/left. `V`, `H`, and `I` select the Select, Hand, and Insert tools;
Escape leaves Insert. Hand mode pans with a mouse drag. Tool shortcuts are
inactive in editable fields and open menus.

Existing highlights remain visible, and links to saved highlights
or bookmarks still open at their saved positions.

In **Select** mode, select text to open the floating actions: Copy, Highlight,
Underline, Strikeout, Comment and Bookmark. The arrow beside Highlight opens
the colour palette and applies the chosen colour; the main Highlight button
uses your last highlight colour. The arrow after Underline and Strikeout
chooses their shared line colour without creating a mark. Both palettes offer
16 presets and a custom colour picker. Highlights start yellow, and lines start
black; each family remembers its last colour on this device. Selecting text
across pages creates a separate mark on each page. Click a mark to change its
colour or style, add or edit its comment, copy its text, or delete it. On a
dark reader background, very dark lines are displayed lighter for visibility
without changing their saved colour. In every reader, comments open in a
sticky-note window with a plain-text field, not a Markdown editor or preview.
Choose **Save note** to save the comment in **Annotations**. A small note icon
beside the passage opens its comment again.
Bookmarks made from selected text use that text as their initial label; you can
rename them in the reader's **Bookmarks** tab.

The borderless **X** saves progress and reading time before returning to the
book's details. If saving fails, retry the unsaved changes or explicitly
choose to leave without saving. A coloured status dot indicates offline,
pending or failed sync, or a settings-save warning; open it for details and a
retry action when synchronization is available. Non-PDF save notifications use
a separate footer instead of covering the book or sidebar. If a change is saved
on this device but cannot sync, it remains queued and the status details explain
the failure.

The PDF reader's left rail has five tabs. Select an active tab again, or use
**Collapse sidebar**, to close the panel. Its open state and selected tab are
remembered on this device. On wide screens the panel sits beside the page; on
narrow screens it overlays the page and closes with Escape when focus is in
the sidebar, or with a page click.

- **Contents** shows the PDF's table of contents. Select a section to jump
  there; the current section is marked.
- **Pages** shows page thumbnails. Select one to jump to that page; the
  current page or spread is outlined.
- **Search** finds text throughout the PDF and lists matching passages.
- **Annotations** lists highlights, underlines, strikeouts and inserted text,
  drawings and images together. Search the list, select an entry to jump to it,
  or expand it to see its full content and comments. All reader formats use
  this compact list style, with an **Edit** button immediately before **Delete**.
  The Delete button asks
  for confirmation; a deleted item can be restored with **Undo** for eight
  seconds. Entries from other files are listed separately and are read-only.
  Add or edit a comment by expanding a mark. Create passage marks and comments
  with the floating selection toolbar; the sidebar reflects those changes
  without duplicating creation controls. Existing private book notes remain
  on the book's **Annotations** page.
- **Bookmarks** lists saved positions. Click an entry to jump there, or use its
  Edit and Delete icons. The bookmark icon in the top toolbar adds or removes a
  bookmark for the current page.

Changes are saved on this device while offline and sync when connected.

Scanned PDF pages (pages that are images with little or no text) are recognized
in your browser so you can select and copy their text. Recognition supports
English and Simplified Chinese. While a page is processed, the toolbar shows its
progress and offers a retry if recognition fails. On narrow screens the status
uses a compact **OCR** indicator; on the smallest screens it appears just below
the toolbar. Page images are never uploaded.
Results are saved on this device, so reopening the book does not run recognition
again. Signing out clears them. Turn recognition off in the layout menu; this
device remembers the choice. OCR models are downloaded from your PandaLibrary
server on first use, not from an external service. Let recognition complete
while online before relying on OCR offline; browser storage eviction may
require downloading the models again. Large image-heavy PDFs can use
substantial device memory, especially during OCR.

### Inserting items

In any reader, open **+**, choose **Text**, **Draw** or **Image**, then click a
point on the page to place it. In PDFs, `I` also opens the insertion menu.
Press Escape to cancel placement.

- **Text:** type a note, choose its size and colour, then click Done, click
  outside the editor, or press Ctrl+Enter or Escape to save. Empty notes are
  discarded.
- **Draw:** draw with a mouse, pen or touch on that page. Choose a colour and
  line width; Undo removes the last stroke and Done saves the drawing.
  Escape offers to discard an unfinished drawing.
- **Image:** choose a PNG, JPEG or WebP file. Attaching a new image needs a
  connection; images already cached on the device remain available offline.

In PDFs, in Select or Insert mode, click an item to select it. Drag the selection
frame to move it; images have corner handles that preserve their aspect ratio.
Double-click text to edit it. Arrow keys move a selected item by 0.5% of the
page (5% with Shift). Delete, Backspace or the Delete button removes an item;
Undo restores it for six seconds. Hand mode does not select or drag items.
Inserts are private, sync like other annotations, and never modify the shared
book file.

## Offline reading

Install PandaLibrary as an app (PWA) from a supported browser. On a book's
**Files** tab, choose **Save for offline** to keep a copy on the device.

While offline you can read saved books. Your progress, highlights, notes and
bookmarks are kept and synced when you reconnect. If the same item changed on
two devices, the latest change wins. Manage offline storage in Settings.
Previously saved changes that match the server are reconciled automatically.
If a conflict or rejection remains, choose **Review changes** to see the
affected book when available and any server reason; retry or discard a change
only after reviewing it.
Text and drawings can also be added offline. Adding a new image needs
a connection; an existing image is available offline only after it has been
viewed and cached on that device. Scanned-page recognition needs the relevant
OCR models to have been downloaded beforehand.

## Bookmarks

Bookmarks stay with their book. All reader formats use the **Bookmarks** tab in
the left rail. Each entry shows its date and time, reading progress, and Edit and
Delete icons on the first row. The second row previews the selected text, or the
opening text of the bookmarked page, truncated to one line. Click the entry to
jump to its saved position; Edit and Delete act without jumping.

Use the bookmark icon in the top toolbar to bookmark the current page immediately.
Its active state indicates that the page is bookmarked; select it again to remove
that bookmark. When text is selected, it becomes the bookmark's initial label.
For pages without text, such as comic pages, a page label is used instead.
A bookmark can be opened only in its original file. Older links to the former
Bookmarks page now open **All Books**.

## Annotations, reviews and comments

The **Annotations** page lists your reviews, passage comments, private book notes,
highlights (including underline and strikeout), inserted text, drawings and images
in newest-first order, with a small cover for each book. Reviews are also
available on the book's **Details** tab. Comments stay attached to their
passages; older book notes remain private and are shown as private notes.

Use the search bar at the top to search your own reviews, comments, private notes,
highlights and inserted text, including short Chinese keywords such as “扣子”.
Use the **All** dropdown beside the search input to choose an annotation type.
Like Bookheap, the dropdown and search input are separate controls with green
focus outlines. Bookheap's status dropdown has no visible **Status** heading.
The type filter works with or without a search and is preserved in the page URL.
The green magnifier searches. After a search the same button becomes **✕**, as in the
header search; select it to clear the search while keeping the selected type. Every
search box in PandaLibrary (Bookheap, highlights, shelves, languages and the reader's
annotation list) uses this same magnifier/✕ button, and all search boxes, dropdowns
and toolbar buttons share one height.
The number immediately after **Your annotations** counts the entries currently
displayed, updating with filters, searches and **Show more**.
The **Annotations** sidebar badge counts all your visible annotations, independent
of these filters. The **Bookheap** badge counts all indexed items, across statuses;
both badges show zero when empty.
Drawings have previews but no searchable text; images also appear in the full feed.
The full list and search results use the same cover, title, preview and colored
category tags. Passage notes are labeled **Comment**, matching the reader toolbar.
Click anywhere on an entry to open its destination: reviews open the book's
review section; comments and marks jump to their passage; inserted text,
drawings and images jump to their position in the reader.
Existing standalone private book notes open book details.
If the annotations API is unavailable after updating the frontend, restart or update the
backend too.
There is no export panel on the Annotations page. Use the book's **Annotations**
tab to export that book's annotations.
The book's **Annotations** tab offers the same annotation types as the sidebar
page, scoped to this book. Filter by type or search text and notes; highlights
and their attached comments retain the chapter view and colour/style filters.
Reviews require a connection; saved reader annotations remain available offline.
Older highlights retain the normal highlight style. Exports label underline and strikeout marks and include
inserted text, drawings and images with their page numbers (images are listed,
not embedded). Oversized exports fail rather than silently dropping items.

## Collections

Use the **Collections** section in the sidebar to browse collections across
all libraries. Its **⋮** menu creates or manages collections. Existing shelves
are preserved as collections; older `/shelves` links and API routes still work.

- **Favorites** is a special collection under **Home** in the sidebar, not in the
  collection list. It is created for you and cannot be renamed or deleted.
  Use the star beside Download on a book page to add or remove a favorite.
- Add books manually, automatically with rules, or both in the same collection.
- Rules can match title, author, series, tag, language, format or reading status.
  Each named rule has its own all/any conditions and works independently:
  a book matching any rule appears in the collection.
- Removing a rule asks whether to remove its matching books or retain them
  as manually added books. Removing rule-mapped books does not remove manual
  additions or books still matched by another rule, and never deletes books
  from their libraries.

Administrators can also create shared collections that other readers can see.
Collections never bypass book visibility or library access restrictions.

For API clients, the existing `/api/v1/shelves` endpoints remain supported.
Collection metadata includes `rule_groups`, an array of
`{id, name, rules: {match: "all" | "any", conditions}}`. Conditions retain the
existing `{field, op, value}` shape. Creating or patching a collection accepts
`rule_groups`; a patch replaces the complete array. Group IDs are stable:
editing a group's conditions updates its live matches immediately.

When deleting group IDs, send `remove_rule_books: true` to stop including their
rule-only matches, or `false` (the default) to retain their currently
actor-visible matches as manual membership. Other groups and existing manual
membership are unaffected. `PUT /api/v1/shelves/{id}/books/{bookID}` adds manual
membership even when rules exist. The corresponding `DELETE` removes only
manual membership; a book still matched by a rule remains in the collection.
These operations never delete the library's book or file.

## Search

Search finds books by title, author or series. Type in the search box in the
header and press Enter or the magnifier button. After a search, the button
becomes **✕**; select it to clear the search. Changing the text brings the
magnifier back so you can search again.

Search works with Chinese and other languages that do not use spaces, and with
short queries such as two-character titles.

## Statistics

The sidebar groups **Books**, **Reading** and **History** under **Statistics**.
Books shows ended reading cycles per month and time per book; Reading shows
time, sessions, active days and streaks; History shows daily session totals and
per-book reading time. Choose a date range in any view. Days follow your time
zone. The combined view remains available at `/stats`.

## Settings

Open Settings from **Account menu → Profile**.

- **Profile:** display name and language (English or Chinese).
- **App passwords:** passwords for reading apps and devices. See
  [Reading apps and devices](./devices.md).
- **Offline storage:** see and remove books saved on this device.
