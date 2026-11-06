-- +goose Up

-- Bookheap: an admin staging index for files that physically live in the heap folder.
-- Heap items are not books; they never appear in catalog, search, OPDS, stats or shelves.

-- SQLite cannot alter CHECK constraints, so import_jobs is rebuilt to accept the
-- 'bookheap' source. No table references import_jobs before this migration, and
-- every column, row, index and foreign key is preserved.
CREATE TABLE import_jobs_v4 (
    id                   INTEGER PRIMARY KEY,
    source               TEXT    NOT NULL CHECK (source IN ('upload', 'drop_folder', 'bookheap')),
    library_id           INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
    user_id              INTEGER REFERENCES users (id) ON DELETE SET NULL,
    original_name        TEXT    NOT NULL,
    sha256               TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
    status               TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'processing', 'imported', 'duplicate', 'failed')),
    error                TEXT,
    book_id              INTEGER REFERENCES books (id) ON DELETE SET NULL,
    duplicate_of_book_id INTEGER REFERENCES books (id) ON DELETE SET NULL,
    created_at           INTEGER NOT NULL,
    finished_at          INTEGER
);
INSERT INTO import_jobs_v4 (id, source, library_id, user_id, original_name, sha256, status, error,
    book_id, duplicate_of_book_id, created_at, finished_at)
SELECT id, source, library_id, user_id, original_name, sha256, status, error,
    book_id, duplicate_of_book_id, created_at, finished_at
FROM import_jobs ORDER BY id;
DROP TABLE import_jobs;
ALTER TABLE import_jobs_v4 RENAME TO import_jobs;
CREATE INDEX import_jobs_status_created ON import_jobs (status, created_at);
CREATE INDEX import_jobs_created ON import_jobs (created_at);

-- rel_path is slash-separated and relative to the heap root. Timestamps are Unix ms.
-- target_* and import_job_id are written by assignment (BH2); BH1 stores defaults.
CREATE TABLE bookheap_items (
    id                   INTEGER PRIMARY KEY,
    rel_path             TEXT    NOT NULL UNIQUE CHECK (length(rel_path) > 0),
    file_name            TEXT    NOT NULL,
    size_bytes           INTEGER NOT NULL CHECK (size_bytes >= 0),
    mtime_ns             INTEGER NOT NULL,
    sha256               TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),   -- NULL only when unreadable
    format               TEXT CHECK (format IS NULL OR format IN ('epub', 'pdf', 'mobi', 'azw3', 'fb2', 'fbz', 'cbz')),
    title                TEXT    NOT NULL,
    authors              TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(authors) AND json_type(authors) = 'array'),
    language             TEXT,
    series               TEXT,
    series_index         REAL,
    cover_sha256         TEXT CHECK (cover_sha256 IS NULL OR length(cover_sha256) = 64),
    source               TEXT    NOT NULL CHECK (source IN ('upload', 'scan')),
    status               TEXT    NOT NULL DEFAULT 'ready'
                         CHECK (status IN ('ready', 'duplicate', 'invalid', 'queued', 'importing', 'failed')),
    error                TEXT,
    duplicate_of_book_id INTEGER REFERENCES books (id) ON DELETE SET NULL,
    duplicate_of_item_id INTEGER REFERENCES bookheap_items (id) ON DELETE SET NULL,
    target_library_id    INTEGER REFERENCES libraries (id) ON DELETE SET NULL,
    target_shelf_ids     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(target_shelf_ids) AND json_type(target_shelf_ids) = 'array'),
    import_job_id        INTEGER REFERENCES import_jobs (id) ON DELETE SET NULL,
    added_by             INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
);
CREATE INDEX bookheap_items_created ON bookheap_items (created_at, id);
CREATE INDEX bookheap_items_sha256 ON bookheap_items (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX bookheap_items_status ON bookheap_items (status);
CREATE INDEX bookheap_items_cover ON bookheap_items (cover_sha256) WHERE cover_sha256 IS NOT NULL;
CREATE INDEX bookheap_items_duplicate_item ON bookheap_items (duplicate_of_item_id) WHERE duplicate_of_item_id IS NOT NULL;
CREATE INDEX bookheap_items_import_job ON bookheap_items (import_job_id) WHERE import_job_id IS NOT NULL;

-- +goose Down

-- Development rollback: heap rows are dropped (their files stay in the heap folder and a
-- later scan re-indexes them). Import history with source 'bookheap' is preserved by
-- mapping it to 'upload', the closest v3 source.
DROP TABLE bookheap_items;
CREATE TABLE import_jobs_v3 (
    id                   INTEGER PRIMARY KEY,
    source               TEXT    NOT NULL CHECK (source IN ('upload', 'drop_folder')),
    library_id           INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
    user_id              INTEGER REFERENCES users (id) ON DELETE SET NULL,
    original_name        TEXT    NOT NULL,
    sha256               TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
    status               TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'processing', 'imported', 'duplicate', 'failed')),
    error                TEXT,
    book_id              INTEGER REFERENCES books (id) ON DELETE SET NULL,
    duplicate_of_book_id INTEGER REFERENCES books (id) ON DELETE SET NULL,
    created_at           INTEGER NOT NULL,
    finished_at          INTEGER
);
INSERT INTO import_jobs_v3 (id, source, library_id, user_id, original_name, sha256, status, error,
    book_id, duplicate_of_book_id, created_at, finished_at)
SELECT id, CASE source WHEN 'bookheap' THEN 'upload' ELSE source END, library_id, user_id, original_name,
    sha256, status, error, book_id, duplicate_of_book_id, created_at, finished_at
FROM import_jobs ORDER BY id;
DROP TABLE import_jobs;
ALTER TABLE import_jobs_v3 RENAME TO import_jobs;
CREATE INDEX import_jobs_status_created ON import_jobs (status, created_at);
CREATE INDEX import_jobs_created ON import_jobs (created_at);
