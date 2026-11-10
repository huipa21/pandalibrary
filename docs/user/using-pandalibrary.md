# Using PandaLibrary

## Signing in and layout

Sign in with the account your administrator gave you. The header holds the
search box, language, theme (light or dark) and your account menu. Search is
only in the header; the sidebar has no Search entry. The sidebar holds
navigation and your shelves; on small screens it opens as a drawer from the
menu button. Select the PandaLibrary logo to return to the dashboard.

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

**Reviews are public; notes are private.** Anyone who can see a book can read
its reviews. Notes and highlights are only visible to you.

The back button returns to the list you came from. The **‹ ›** buttons, or the
`[` and `]` keys, move to the previous or next book in that list.

## Reader

Choose **Read** or **Resume** on a book to open it in the browser. Your
position is saved automatically and syncs across your devices.

In non-PDF readers you can:

- change the font, size, spacing, theme and page flow (saved per format, with
  optional per-book settings);
- select text to highlight it and attach a note;
- add bookmarks at exact positions.

Reading time is recorded as sessions for your stats; idle time is not counted.

PDFs fill the screen below a compact toolbar, without the app header or
sidebar. Progress shows two decimal places (for example, **10.05%**), while
saved positions retain the page and your scroll position within it. Type a page
number in the counter to jump there. Use Zoom, Page display and Rotate to
adjust the view; below 640 px these menus are inside **More view options**.
New books start in continuous mode with Automatic zoom unless you have saved
a different PDF default.

View changes save automatically after one second. Layout, cover display, zoom
presets and page theme also become defaults for other PDFs; rotation and free
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
the colour palette; the main Highlight button uses your last colour. Selecting
text across pages creates a separate mark on each page. Click a mark to change
its colour or style, add or edit its comment, copy its text, or delete it.
Comment editors show a live Markdown preview.
Bookmarks made from selected text use that text as their initial label; you can
rename them in the Annotations tab.

The borderless **X** saves progress and reading time before returning to the
book's details. If saving fails, retry the unsaved changes or explicitly
choose to leave without saving. A coloured status dot indicates offline,
pending or failed sync, or a settings-save warning; open it for details and a
retry action when synchronization is available.

A narrow tab rail on the left edge opens the reader sidebar: **Contents**,
**Pages**, **Annotations** and **Bookmarks** (Contents, Pages and Bookmarks are
coming soon). Select a tab to open it and select it again, or use the collapse
button, to close the sidebar. On wide screens the sidebar sits beside the page
and keeps your place; on smaller screens it floats over the page, and Escape or
a click on the page closes it. This device remembers whether the sidebar is
open and which tab was last used. Clicking a comment marker on the page shows
that entry in the Annotations tab.

The **Annotations** tab groups items by page. Search marks, comments,
bookmarks and inserted items. Open an entry to jump to its
position; edit comments, bookmark labels and inserted text there, or delete an
item and choose **Undo** within eight seconds. Entries from another file are
listed separately and cannot be changed from the current file. Book-level
Markdown notes can be added, edited and deleted at the bottom of the tab.
Escape closes the sidebar and returns focus to its tab. Collapsing keeps an
unsaved note; switching to another tab asks first. Changes are saved on this
device while offline and sync when connected.

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

The **Bookmarks** page lists your saved positions across all books. Open,
rename or delete them there. A bookmark is not opened if its original file is
no longer available.

## Notes and highlights

The **Notes** page collects every note and highlight you have made, with
search. Notes are written in Markdown. Export notes as a Markdown file (one
book) or a ZIP (several books); the files work well in Obsidian.
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
