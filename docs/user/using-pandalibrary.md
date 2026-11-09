# Using PandaLibrary

## Signing in and layout

Sign in with the account your administrator gave you. The header holds search,
language, theme (light or dark) and your account menu. The sidebar holds
navigation and your shelves; on small screens it opens as a drawer from the
menu button.

## Dashboard

The dashboard is your home page. It shows reading feeds such as Continue
Reading, Recently Added and Read, plus any shelves you add.

To change it, use the **⋮** button next to **Dashboard** in the sidebar. You can
add, remove and reorder sections, add a shelf as a section, or save an empty
dashboard. The layout is saved to your account.

## Browsing books

**All Books** and the library, author, series and tag pages list the books you
can see. You can:

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
saved positions retain the exact page. Use the left and right arrow keys to
turn pages. Existing highlights remain visible, and links to saved highlights
or bookmarks still open at their saved positions.

The borderless **X** saves progress and reading time before returning to the
book's details. If saving fails, retry the unsaved changes or explicitly
choose to leave without saving. A coloured status dot indicates offline,
pending or failed sync; open it for details and a retry action.

PDF annotation and bookmark creation is temporarily unavailable while the
new PDF tools are being assembled. Other formats keep their existing controls.

## Offline reading

Install PandaLibrary as an app (PWA) from a supported browser. On a book's
**Files** tab, choose **Save for offline** to keep a copy on the device.

While offline you can read saved books. Your progress, highlights, notes and
bookmarks are kept and synced when you reconnect. If the same item changed on
two devices, the latest change wins. Manage offline storage in Settings.

## Bookmarks

The **Bookmarks** page lists your saved positions across all books. Open,
rename or delete them there. A bookmark is not opened if its original file is
no longer available.

## Notes and highlights

The **Notes** page collects every note and highlight you have made, with
search. Notes are written in Markdown. Export notes as a Markdown file (one
book) or a ZIP (several books); the files work well in Obsidian.

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

Search finds books by title, author or series. It works with Chinese and other
languages that do not use spaces, and with short queries such as two-character
titles.

## Stats

**Stats** shows daily reading time, a calendar heatmap, streaks, books finished
per month and time per book for a date range. Days follow your time zone.

## Settings

Open Settings from **Account menu → Profile**.

- **Profile:** display name and language (English or Chinese).
- **App passwords:** passwords for reading apps and devices. See
  [Reading apps and devices](./devices.md).
- **Offline storage:** see and remove books saved on this device.
