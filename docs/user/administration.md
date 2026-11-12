# Administration

These features are available to administrator accounts only. Installation,
configuration, backups and upgrades are in the [project README](../../README.md).

## First administrator

On first start, open `/setup` and enter the one-time setup token from the server
logs. Treat the token and server logs as credentials. You can also create or
reset accounts from the command line:

```sh
./pandalibrary user create --username admin --admin
./pandalibrary user reset-password --username admin
```

## Adding books

There are four ways to add books:

- **Upload to a library:** upload books on **Admin → Uploads & imports**.
- **Upload to the Bookheap:** the **Upload** button in the header sends books to
  the Bookheap. Optionally choose a library in the upload dialog to queue each
  uploaded book for import automatically; leave it blank to assign later.
  Completed uploads have a green checkmark and a results summary. If library
  assignment fails after upload, retry it without uploading the file again,
  or assign it from the Bookheap.
- **Bookheap folder:** copy files into the Bookheap folder (subfolders are
  fine), then select **Scan** on the Bookheap page.
- **Drop folder:** files copied into the drop folder are imported automatically
  once they have stopped changing for three seconds. A subfolder named after a
  library's slug imports into that library; files at the top level need a
  default library.

Book details are read from the files and can be filled in from online metadata
providers.

## Bookheap

The Bookheap is a staging area for books that are not in a library yet. Readers
never see it.

The page lists each file's title, format and status: Ready, Duplicate, Invalid,
Queued/Importing or Failed. Filter by status or search, and switch between grid
and list view.

Select items (across pages if needed), then:

- **Assign…** them to a library and, optionally, manual shelves. Assigned books
  are imported and leave the heap.
- **Delete…** them.

Duplicates and failures stay in the heap with a reason. Failed items can be
assigned again. Bookheap and shelf counters refresh automatically while queued
imports finish, including when a status filter hides those books.

## Admin pages

| Page | What it does |
|---|---|
| **User accounts** | Create, edit, disable, re-enable and delete accounts; reset passwords; revoke sign-ins and app passwords |
| **Libraries & access** | Create libraries and choose which readers can see each one. Administrators see all libraries |
| **Hidden books** | Hide specific books from one reader. Hidden books disappear from that reader's lists, search and downloads |
| **Uploads & imports** | Import history, including failures and their reasons |
| **Metadata providers** | Turn online sources on or off and set their priority. Open Library and Google Books are on by default; NeoDB and Hardcover need a token |
| **Maintenance** | See scheduled jobs and run one now: database backup, cleanup, unused annotation images, orphaned file removal, database optimization and search index checks |

Resetting a password or disabling an account signs the user out everywhere and
revokes their app passwords.

The daily **Unused annotation images** job removes image ownership older than
24 hours when no live page annotation uses it. Shared image files are kept
while another account still owns them. Orphaned file removal also cleans up
abandoned images and images belonging to deleted accounts.

## Editing book metadata

On a book page, administrators can open the metadata editor. It shows the
current value next to the values from each provider, so you can pick each field.

## Backups

The maintenance job keeps seven verified database backups. These do not replace
an off-site backup of the whole data folder: back up the database and the book
files, covers and annotation images (`assets/`) together. Database backups do
not include files waiting in the Bookheap folder; after a restore, run **Scan**
on the Bookheap page.
