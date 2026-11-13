# PandaLibrary user guide

PandaLibrary is a self-hosted ebook library. You run one server, then read and
organize your books from a web browser, an OPDS reading app, or KOReader.

Supported formats: EPUB, PDF, MOBI, AZW3, FB2, FBZ and CBZ. Which formats the
browser reader can open depends on your browser.

## Guides

| Guide | For | Covers |
|---|---|---|
| [Using PandaLibrary](./using-pandalibrary.md) | Everyone | Dashboard, browsing, book pages, the reader, offline reading, bookmarks, notes, collections, search, statistics, settings |
| [Reading apps and devices](./devices.md) | Everyone | OPDS apps and KOReader progress sync |
| [Administration](./administration.md) | Administrators | Adding books, the Bookheap, accounts, libraries and access, metadata providers, maintenance |

Installation, configuration, backups and upgrades are in the
[project README](../../README.md).

## What each part does

| Part | Where | What it does |
|---|---|---|
| Dashboard | Sidebar → **Home → Dashboard** | Your home page: reading feeds and the collections you choose to show |
| All Books | `/books` (not a sidebar item) | Computed list of every book you can see, with filters and sorting |
| Favorites | Sidebar → **Home → Favorites** | Your special collection of favorite books |
| Libraries | Sidebar → **Libraries** | Expand or collapse all available libraries; each book belongs to one library |
| Authors, Series, Tags | Book metadata links or catalog filters | Browse by author, series or tag |
| Book page | Open any book | Details, reading status, rating, reviews, collections, files, activity and book-scoped annotations |
| Reader | **Read** on a book | Read in the browser and add highlights, passage comments and bookmarks |
| Bookmarks | Open a book in the reader | Saved reading positions for that book |
| Annotations | Sidebar → **Annotations** | Reviews, comments, highlights, inserted text and drawings in date order; consistent search results and direct navigation |
| Collections | Sidebar → **Collections** | Logical containers across libraries, with manual additions and independent automatic rules |
| Search | Header search | Find books by title, author or series |
| Statistics | Sidebar → **Statistics → Books, Reading, History** | Per-book and monthly totals, daily reading time, streaks and reading history |
| Settings | Account menu → **Profile** | Profile, language, app passwords for devices, and offline storage |
| Bookheap | Sidebar → **Bookheap** (admins) | Staging area for books that are not in a library yet |
| Admin | Account menu → **Admin** (admins) | Accounts, libraries and access, hidden books, imports, metadata providers, maintenance |
