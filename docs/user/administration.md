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
  Choose a library (required), optionally select a collection, and choose
  **Public** (the default) or **Private**. Every uploaded book is staged in the
  Bookheap and automatically queued for import into the selected library and collection.
  Completed uploads have a green checkmark and a results summary. If library
  assignment fails after upload, retry it without uploading the file again,
  or assign it from the Bookheap. Retries keep the original library, collection and
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
they are never available anonymously. Private books are visible only to their
owner, normally the account that uploaded them. The choice follows a Bookheap
upload when it is later assigned to a library. Retrying an upload keeps its
original choice.
Existing books and books discovered in folders retain library-based access
unless an administrator changes their visibility.
Per-reader hidden-book restrictions still apply to public books.

The owner can change a book's visibility from its **Details** tab using the
eye icon among the actions below **Read** or **Resume**, then confirming the
change. An administrator can also change an ownerless book: confirmation
assigns them ownership and replaces any library-based access with the chosen
visibility. The control cannot restore library-based access. Administrators
cannot change another owner's visibility.

## Library ownership

Use the sidebar's **Libraries → ⋮** menu for **New Library** and
**All Libraries**, rather than looking for a Libraries tab in Admin.
**New Library** opens a dialog with the library name, slug and icon. **All Libraries**
shows cover cards; open a cover to edit that library's settings and manage access.
The access picker lists eligible readers in a scrollable dropdown and narrows
the list as you type. Library creation, editing, access management and deletion
remain administrator-only.

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

- **Assign…** them to one library and, optionally, collections. Assigned books
  are imported and leave the heap.
- **Delete…** them.

Duplicates and failures stay in the heap with a reason. Failed items can be
assigned again. Bookheap and collection counters refresh automatically while queued
imports finish, including when a status filter hides those books.

Uploading or scanning into the heap checks for duplicates among unassigned heap items.
Existing library copies are checked only after a destination library is chosen.
An item found to duplicate a book in one library can be reassigned to a different
library through the assignment API.

## Admin pages

| Page | What it does |
|---|---|
| **Users** | Search accounts by category; select numbered rows for single-account editing or bulk enable, disable, revoke and delete actions. Server CLI help is at the bottom |
| **Hidden books** | Hide specific books from one reader. Hidden books disappear from that reader's lists, search and downloads |
| **Uploads** | Upload books and view processing history, including failures and their reasons |
| **Metadata providers** | Turn online sources on or off and set their priority. Open Library and Google Books are on by default; NeoDB and Hardcover need a token |
| **Dicts** | Configure the online dictionary API used by **Look up**; see [Dictionaries](#dictionaries) |
| **Maintenance** | See scheduled jobs and run one now: database backup, cleanup, unused annotation images, orphaned file removal, database optimization and search index checks |
| **Backup** | Create and download full database-and-media `.tar.gz` backups; stage a server-saved or uploaded backup for restoration on restart |

Resetting a password or disabling an account signs the user out everywhere and
revokes their app passwords.

The daily **Unused annotation images** job removes image ownership older than
24 hours when no live page annotation uses it. Shared image files are kept
while another account still owns them. Orphaned file removal also cleans up
abandoned images and images belonging to deleted accounts.

## Editing book metadata

On a book page, administrators have a **Metadata** tab between **Details** and
**Files**; **Edit metadata** in the **Details** card opens it as well. Other
users do not see the tab. The tab initially shows the saved metadata read-only,
including tags, genres, moods, age rating, content rating and series total.
A small badge beside each field shows where its saved value came from. Select
the **Edit** pencil under the cover to enable editing; it becomes the **Save
metadata** icon. The adjacent restore icon is enabled when there are unsaved
changes and restores the values from before editing. Saving returns to read-only
mode and disables restore. No provider lookup is required for direct edits.
Contributors retain their order and roles, and series positions and
identifiers can also be edited. Identifiers and provider ratings are in the
initially expanded **Provider metadata** section; ratings can only be copied from
search results. Remove every tag to save an empty tag list. Leaving the tab
with unsaved changes asks for confirmation.

Select the **Search metadata** icon next to restore under the cover to search
providers. The ISBN, title and author are prefilled from the book and can be
changed; uncheck providers to search only some of them. With an empty ISBN and
title, the search uses the book's saved metadata. Select **Search providers**
to search the chosen sources concurrently. Only sources that return candidates
have a tab. Select a source tab and, if it
has several matches, an alternative to compare with your draft values on the
same rows. Buttons between the columns copy a found value or restore that
field's saved value. You can mix fields from several sources; switching tabs
does not discard edits. **Use all found values** copies available values without
clearing fields the source does not supply. Individual empty values can still
be chosen to clear a field.

Copying values only changes the draft. **Save metadata** commits manual edits
and selected provider values together, preserving their field sources, then
returns to the read-only **Metadata** tab. Use the **Metadata** back button to
return without saving and continue editing the draft. Editing
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

## Dictionaries

The reader's **Look up** action uses an online dictionary API configured by an
administrator. PandaLibrary does not store dictionary data itself. On
**Admin → Dicts**, enter:

- **API address:** the base URL of the dictionary API, for example
  `https://dict.example.org/api/v1/dictionary`.
- **API key** (optional): sent as `Authorization: Bearer <key>`. The key is
  write-only and is not shown again after saving.

Select **Test connection** to check that the API answers and lists its
directions and sources. The settings are stored in the main PandaLibrary
database, so they are included in full-data backups.

The API must implement the same JSON responses as PandaLibrary's own
`/api/v1/dictionary/status` and `/api/v1/dictionary/lookup` endpoints:

- `GET {address}/status` returns the available directions and sources:

  ```json
  {
    "directions": [{"from": "en", "to": "zh", "sources": ["ecdict"]}],
    "sources": [{"id": "ecdict", "name": "ECDICT", "license": "MIT",
                 "url": "https://github.com/skywind3000/ECDICT",
                 "entries": 770000, "importedAt": "2026-01-01T00:00:00Z"}]
  }
  ```

- `GET {address}/lookup?q=<text>&from=<en|zh|ja>&to=<en|zh|ja>&limit=<1-50>`
  returns matching entries:

  ```json
  {
    "query": "running", "term": "run", "from": "en", "to": "zh",
    "entries": [{"source": "ecdict", "sourceName": "ECDICT", "headword": "run",
                 "reading": "rʌn", "partOfSpeech": "v.",
                 "definitions": ["跑"], "hiddenDefinitions": [],
                 "match": "lemma"}]
  }
  ```

  `reading`, `partOfSpeech` and `hiddenDefinitions` are optional; `match` is
  `exact`, `lemma` or `prefix`. A `400` response with an RFC 7807 problem JSON
  `detail` is shown to the reader as an invalid request.

Readers see each dictionary's name with its entries. Without an API address,
lookup offers no directions. If the API is unreachable, readers see the
dictionary as unavailable (HTTP 503); collecting words into wordbooks still
works, without dictionary snapshots.

For API clients, the settings are at `GET`/`PATCH /api/v1/admin/dictionary/settings`,
and `POST /api/v1/admin/dictionary/test` checks the connection.

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
