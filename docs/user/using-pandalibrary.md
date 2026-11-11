# Using PandaLibrary

## Signing in and layout

Sign in with the account your administrator gave you. The header holds the
search box, language, theme (light or dark) and your account menu. Search is
only in the header; the sidebar has no Search entry. The sidebar holds
navigation and your shelves; on small screens it opens as a drawer from the
menu button. Select the PandaLibrary logo to return to the dashboard.

The header, sidebar and main content keep the same width and position when
switching between pages with and without a vertical scrollbar.

## Dashboard

The dashboard is your home page. It shows reading feeds such as Continue
Reading, Recently Added and Read, plus any shelves you add.

To change it, use the **⋮** button next to **Dashboard** in the sidebar. You can
add, remove and reorder sections, add a shelf as a section, or save an empty
dashboard. The layout is saved to your account.

## Browsing books

**All Books** and the library, author, series and tag pages list the books you
can see. The **All Books** entry in the sidebar shows how many books you can
see across all your libraries, like the counts next to your shelves. You can:

- switch between grid and list view with the view button;
- filter by author, series or tag and change the sort order;
- clear filters with the clear-filters button.

Books without a cover get a generated cover. Badges show each book's formats and
your reading status.

## Book pages

Opening a book shows four tabs:

| Tab | What it shows |
|---|---|
| **Details** | Description and metadata, your reading status and rating, shelves, and reviews |
| **Files** | The book's files. Read, download or save a file for offline reading |
| **Activities** | Your reading progress, reading sessions and summary. You can add a session by hand |
| **Highlights** | Your highlights for this book; each one opens the reader at that place |

Reading statuses: Unread, Want to read, Reading, Re-reading, On hold, Read,
Skimmed and Abandoned.

**Reviews are public; notes and comments are private.** Anyone who can see a
book can read its reviews. Your passage comments, book notes and highlights
are only visible to you.

The back button returns to the list you came from. The **‹ ›** buttons, or the
`[` and `]` keys, move to the previous or next book in that list.

## Reader

Choose **Read** or **Resume** on a book to open it in the browser. Your
position is saved automatically and syncs across your devices.

In non-PDF readers you can:

- open **Reader settings → Format** to change font, size, spacing and
  background live; page flow stays in Reader settings. Use **Save settings**
  for this book or **Save as format default** for other books of that format;
- select text to highlight it and attach a note;
- add bookmarks at exact positions.

Reading time is recorded as sessions for your stats; idle time is not counted.

PDFs fill the screen below a compact toolbar, without the app header or
library sidebar. Progress shows two decimal places (for example, **10.05%**), while
saved positions retain the page and your scroll position within it. Type a page
number in the counter to jump there. Use Zoom, Page display, Format and Rotate to
adjust the view; below 640 px these menus are inside **More view options**.
New books start in continuous mode with Automatic zoom unless you have saved
a different PDF default.

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
without changing their saved colour. Comment editors show a live Markdown
preview.
Bookmarks made from selected text use that text as their initial label; you can
rename them in the reader's **Bookmarks** tab.

The borderless **X** saves progress and reading time before returning to the
book's details. If saving fails, retry the unsaved changes or explicitly
choose to leave without saving. A coloured status dot indicates offline,
pending or failed sync, or a settings-save warning; open it for details and a
retry action when synchronization is available.

The reader's left rail has four tabs. Select an active tab again, or use
**Collapse sidebar**, to close the panel. Its open state and selected tab are
remembered on this device. On wide screens the panel sits beside the page; on
narrow screens it overlays the page and closes with Escape when focus is in
the sidebar, or with a page click.

- **Contents** shows the PDF's table of contents. Select a section to jump
  there; the current section is marked.
- **Pages** shows page thumbnails. Select one to jump to that page; the
  current page or spread is outlined.
- **Annotations** lists highlights, underlines, strikeouts and inserted text,
  drawings and images together. Search the list, select an entry to jump to it,
  or expand it to see its full content and comments. The Delete button asks
  for confirmation; a deleted item can be restored with **Undo** for eight
  seconds. Entries from other files are listed separately and are read-only.
  Add or edit a comment by expanding a mark. Standalone book notes are no
  longer created in the reader; existing private book notes remain on the
  **Annotations** page.
- **Bookmarks** lists saved positions and lets you jump, rename or delete them.
  **Bookmark this page** adds a page-level bookmark; select it again to remove
  that bookmark. Selection bookmarks remain separate.

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

### Inserting items in PDFs

Choose **Insert** (`I`), click a point on the page, then choose **Text**,
**Draw** or **Image**.

- **Text:** type a note, choose its size and colour, then click Done, click
  outside the editor, or press Ctrl+Enter or Escape to save. Empty notes are
  discarded.
- **Draw:** draw with a mouse, pen or touch on that page. Choose a colour and
  line width; Undo removes the last stroke and Done saves the drawing.
  Escape offers to discard an unfinished drawing.
- **Image:** choose a PNG, JPEG or WebP file. Attaching a new image needs a
  connection; images already cached on the device remain available offline.

In Select or Insert mode, click an item to select it. Drag the selection frame
to move it; images have corner handles that preserve their aspect ratio.
Double-click text to edit it. Arrow keys move a selected item by 0.5% of the
page (5% with Shift). Delete, Backspace or the Delete button removes an item;
Undo restores it for six seconds. Hand mode does not select or drag items.
Inserts are private, sync like other annotations, and never modify the shared
PDF file.

## Offline reading

Install PandaLibrary as an app (PWA) from a supported browser. On a book's
**Files** tab, choose **Save for offline** to keep a copy on the device.

While offline you can read saved books. Your progress, highlights, notes and
bookmarks are kept and synced when you reconnect. If the same item changed on
two devices, the latest change wins. Manage offline storage in Settings.
For PDFs, text and drawings can also be added offline. Adding a new image needs
a connection; an existing image is available offline only after it has been
viewed and cached on that device. Scanned-page recognition needs the relevant
OCR models to have been downloaded beforehand.

## Bookmarks

Bookmarks stay with their book. Open the book in the reader to jump to, rename
or delete its saved positions. For PDFs, use the **Bookmarks** tab in the
reader's left rail; other formats have a **Bookmarks** section in the reader.
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
The green magnifier searches; the X clears the search and restores the full feed.
Drawings have previews but no searchable text; images also appear in the full feed.
The full list and search results use the same cover, title, preview and colored
category tags. Passage notes are labeled **Comment**, matching the reader toolbar.
Click anywhere on an entry to open its destination: reviews open the book's
review section; comments and marks jump to their passage; inserted text,
drawings and images jump to their position in the reader.
Existing standalone private book notes open book details.
If the annotations API is unavailable after updating the frontend, restart or update the
backend too.
There is no export panel on the Annotations page. Use the book's **Highlights**
tab to export that book's annotations.
The book's **Highlights** tab labels underline and strikeout marks and can
filter by style; older highlights retain the normal highlight style. It also
shows inserted text. Exports label underline and strikeout marks and include
inserted text, drawings and images with their page numbers (images are listed,
not embedded). Oversized exports fail rather than silently dropping items.

## Shelves

Open the three-dot menu beside **Shelves** in the sidebar and choose **New shelf**
to create a shelf, or **Manage shelves** to browse and manage existing shelves.

- **Favorites** is created for you and cannot be renamed or deleted.
- **Manual shelves** contain the books you add to them.
- **Automatic shelves** fill themselves from rules. Rules can match title,
  author, series, tag, language, format or reading status, using all or any of
  the conditions. A shelf's type cannot be changed after it is created.

Administrators can also create shared shelves that other readers can see.

## Search

Search finds books by title, author or series. Type in the search box in the
header and press Enter or the magnifier button. After a search, the button
becomes **✕**; select it to clear the search. Changing the text brings the
magnifier back so you can search again.

Search works with Chinese and other languages that do not use spaces, and with
short queries such as two-character titles.

## Stats

**Stats** shows daily reading time, a calendar heatmap, streaks, books finished
per month and time per book for a date range. Days follow your time zone.

## Settings

Open Settings from **Account menu → Profile**.

- **Profile:** display name and language (English or Chinese).
- **App passwords:** passwords for reading apps and devices. See
  [Reading apps and devices](./devices.md).
- **Offline storage:** see and remove books saved on this device.
