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

Stop the server before running database CLI commands (`user` or `migrate`).
They now share the server's exclusive data lock and fail clearly if it is in use;
use the admin account UI for changes while the server is running.

## Adding books

There are four ways to add books:

- **Upload to a library:** upload books on **Admin → Uploads**.
- **Header upload:** the **Upload** button in the header opens the upload dialog.
  Choose a library (required), optionally select a manual shelf, and choose
  **Public** (the default) or **Private**. Every uploaded book is staged in the
  Bookheap and automatically queued for import into the selected library and shelf.
  Completed uploads have a green checkmark and a results summary. If library
  assignment fails after upload, retry it without uploading the file again,
  or assign it from the Bookheap. Retries keep the original library, shelf and
  visibility choices.
- **Bookheap folder:** copy files into the Bookheap folder (subfolders are
  fine), then select **Scan** on the Bookheap page.
- **Drop folder:** files copied into the drop folder are imported automatically
  once they have stopped changing for three seconds. A subfolder named after a
  library's slug imports into that library; files at the top level need a
  default library.

Book details are read from the files and can be filled in from online metadata
providers.

When uploading, choose **Public** (the default) or **Private**. Public books are
visible to all signed-in users, even without access to the destination library;
they are never available anonymously. Private books are visible only to the
account that uploaded them. The choice follows a Bookheap upload when it is
later assigned to a library. Retrying an upload keeps its original choice.
Existing books and books discovered in folders retain library-based access.
Per-reader hidden-book restrictions still apply to public books.

The uploader can change a book's visibility from its **Details** tab, using the
visibility icon below the cover and confirming the change.
It appears directly below **Read** or **Resume** and shows the current visibility.
Books without a recorded uploader retain library-based access; administrators
cannot take ownership or change another uploader's visibility with this control.

## Library ownership

Each book belongs to exactly one library. Changing its library moves the book
and all its formats; it does not add a second library membership. Collections
are logical groups and can include books from different libraries.

Identical files imported into different libraries create separate books.
Duplicate detection applies within the selected destination library. A move
is rejected if that library already contains one of the book's files.
Library-based access follows the destination; private ownership, public sharing
and per-reader hidden-book restrictions remain unchanged.

On disk, immutable content-addressed files and covers are shared between library
copies, rather than duplicated into per-library folders. Moving a book does not
rename its blobs. Deleting a book never immediately deletes shared media;
orphan cleanup retains blobs while any book still references them.

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

Uploading or scanning into the heap checks for duplicates among unassigned heap items.
Existing library copies are checked only after a destination library is chosen.
An item found to duplicate a book in one library can be reassigned to a different
library through the assignment API.

## Admin pages

| Page | What it does |
|---|---|
| **Users** | Search accounts by category; select numbered rows for single-account editing or bulk enable, disable, revoke and delete actions. Server CLI help is at the bottom |
| **Libraries & access** | Create libraries and choose which readers can see each one. Administrators see all libraries |
| **Hidden books** | Hide specific books from one reader. Hidden books disappear from that reader's lists, search and downloads |
| **Uploads** | Upload books and view processing history, including failures and their reasons |
| **Metadata providers** | Turn online sources on or off and set their priority. Open Library and Google Books are on by default; NeoDB and Hardcover need a token |
| **Maintenance** | See scheduled jobs and run one now: database backup, cleanup, unused annotation images, orphaned file removal, database optimization and search index checks |
| **Backup** | Create and download full database-and-media `.tar.gz` backups; stage a server-saved or uploaded backup for restoration on restart |

Resetting a password or disabling an account signs the user out everywhere and
revokes their app passwords.

The daily **Unused annotation images** job removes image ownership older than
24 hours when no live page annotation uses it. Shared image files are kept
while another account still owns them. Orphaned file removal also cleans up
abandoned images and images belonging to deleted accounts.

## Editing book metadata

On a book page, administrators can open **Edit metadata** from the **Details**
card. The form starts with the saved metadata, including tags. Edit values
directly and use **Save metadata** at the bottom; no provider lookup is required.
Contributors retain their order and roles, and series positions and identifiers
can also be edited. Remove every tag to save an empty tag list.

Select **Find metadata** at the top right to search enabled sources concurrently.
Only sources that return candidates have a tab. Select a source tab and, if it
has several matches, an alternative to compare with the editable values on the
same rows. Buttons between the columns copy a found value or restore that
field's saved value. You can mix fields from several sources; switching tabs
does not discard edits. **Use all found values** copies available values without
clearing fields the source does not supply. Individual empty values can still
be chosen to clear a field.

Copying values only changes the draft. **Save metadata** commits manual edits
and selected provider values together, preserving their field sources. Editing
a copied value manually makes that field a manual edit. Covers are previewed
through the server, not downloaded directly from a provider in your browser.
Failed saves keep the draft for retry. Expired provider results must be searched
and chosen again before saving.

For API clients, `POST /api/v1/books/{id}/metadata/apply` accepts
`{request_key, fields: {field: {provider, reference}}, patch?}` and returns
`{book}`. The optional `patch` uses the catalog metadata patch shape; it cannot
include `library_id` or a field already selected in `fields`. Selected values
come from the server's cached candidates. Requests without provider selections
should use `PATCH /api/v1/books/{id}` instead.

## Backups

Full-data backups are single `.tar.gz` files saved in `<data-dir>/backups/`.
They contain a consistent SQLite snapshot (including accounts, reading state,
settings and credentials), all `files/`, `covers/`, `assets/`, import staging
(`tmp/`), Bookheap and drop-folder contents. Configured external Bookheap/drop
folders are included and restored to the directories configured on the target
server. Managed directories must not overlap each other or the backups/database
directory, and must not be symlinks. Do not copy into or otherwise externally
change managed folders while a backup is running.

Download archives and keep an off-site copy. These archives are **not encrypted**:
protect them like the original database, passwords and private books. They do
not include the application binary, environment configuration, TLS/proxy setup,
client-side browser/PWA data, or the backups directory itself. Full archives are
not automatically pruned. The separate daily maintenance job still retains seven
database-only backups; those cannot be uploaded to the full-data restore API.

### Full-data API

All routes require an administrator session cookie. POST routes enforce the same
origin protection as other administration APIs. Errors use the normal problem
JSON response.

| Request | Successful response |
|---|---|
| `GET /api/v1/admin/backups` | `200 {"backups":[{"name":"full-….tar.gz","size_bytes":123,"created_at":"RFC3339"}],"restore_pending":false,"restart_required":false,"max_archive_bytes":17179869184}` |
| `POST /api/v1/admin/backups` | `201 {"backup":{"name":"full-….tar.gz","size_bytes":123,"created_at":"RFC3339"}}` |
| `GET /api/v1/admin/backups/{name}` | `200` gzip attachment (supports range downloads) |
| `POST /api/v1/admin/backups/restore` | `202 {"status":"staged","restore_pending":true,"restart_required":true,"message":"…","staged_at":"RFC3339"}` |

Creation is synchronous and briefly pauses other app requests and background
data writers while capturing and verifying the complete archive. Large libraries
can take a long time: configure proxy/client timeouts appropriately.

Restore accepts either `application/json` with
`{"name":"full-….tar.gz","confirm":true}` for a server-saved archive, or a
`multipart/form-data` upload with **`confirm=true` first, then `file`**. For example:

```sh
curl --fail -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"full-….tar.gz","confirm":true}' \
  https://books.example.org/api/v1/admin/backups/restore

curl --fail -b cookies.txt -F confirm=true -F file=@full-backup.tar.gz \
  https://books.example.org/api/v1/admin/backups/restore
```

Archives are bounded to 16 GiB compressed, 64 GiB expanded, 16 GiB per file,
100,000 entries and 32 nested path separators. The existing
`PANDA_MAX_UPLOAD_MB` request limit (default 1024 MiB) and reverse proxy limits
also apply to uploads; increase them for larger archives or use the CLI.
Validation checks the archive format/version, safe paths, regular files and
directories only, duplicate entries, file sizes/checksums, SQLite integrity,
foreign keys, matching binary schema version and presence of referenced managed
blobs. Symlinks, hard links and special files are rejected. Use the same schema
version of PandaLibrary to restore a version-1 archive.

An invalid archive returns `400` without changing live data. Oversized HTTP
requests return `413`; an already staged restore returns `409` (it is not
silently overwritten). Missing saved archives return `404`.

### Restore lifecycle and recovery

**A `202` response means staged, not restored. A restart is required.** The app
continues serving its current data until stopped; any changes after the backup
point, including changes while a restore is pending, will be discarded. Tell
readers to stop syncing, stop external folder writers, and restart promptly.

On the next startup, before SQLite is opened or workers/listeners start, the
archive is validated again and replacements are prepared. The old database,
SQLite sidecars and managed folders are replaced; the entire backups directory
is preserved. A recovery journal and same-filesystem sibling renames permit
rollback after replacement errors or an interrupted process. A failed restore
aborts startup and reports the error in logs; it does not quietly start against
partially replaced data. Correct the problem (for example insufficient disk
space or permissions) and retry startup.

Allow substantial free disk space: creation and validation use an extracted
verification copy; restore temporarily retains old data and both extracted and
prepared new data, as well as the pending archive. Ordinary process interruption
is recoverable; filesystem/device failure and sudden power loss still require
off-site backups (Windows does not support directory fsync here).

For an offline recovery when the UI is unavailable:

```sh
# Stop every PandaLibrary process using this data directory first.
PANDA_DROP_DIR=/media/drop PANDA_BOOKHEAP_DIR=/media/heap \
  ./pandalibrary restore --data-dir /data --file full-backup.tar.gz --confirm
# Start with the same data/drop/bookheap configuration to apply the staged restore.
```

The CLI validates and stages only; it reports that restart/startup is required.
The server and database CLI commands share a process data lock, so restoration
cannot replace a database still open by another cooperating PandaLibrary process.
Do not run older binaries or external SQLite tools against the same directory.
Keep the configured external folders exclusive to this application.

To cancel a staged restore, stop the server and remove only
`backups/.pending-restore.tar.gz`, **provided no `.restore-journal.json` exists**.
Never delete or edit the recovery journal or `.panda-old-*` siblings during an
interrupted restore; let startup recover them first. Restoring also restores
sessions, app passwords, setup state and account credentials from the backup.
It does **not** automatically invalidate restored credentials or sessions:
password changes, account disabling and credential revocations made after the
backup are undone. An unexpired session or app password in the backup can become
valid again. Browser/PWA caches and offline queues are not reset by the server.
Clear stale offline data/queues before reconnecting clients, and revoke sessions
or rotate credentials as appropriate before allowing sync against restored data.
