-- PandaLibrary initial schema.
-- Migrations are immutable once merged; change the schema by adding a new migration
-- (see docs/architecture/migrations.md).
-- Conventions: see docs/architecture/database.md (timestamps = INTEGER unix milliseconds UTC,
-- booleans = INTEGER 0/1, JSON = TEXT checked with json_valid).

-- +goose Up

-- ---------------------------------------------------------------------------
-- Users & authentication
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT    NOT NULL COLLATE NOCASE UNIQUE CHECK (length(username) BETWEEN 1 AND 64),
    display_name  TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,                       -- argon2id PHC string
    role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    locale        TEXT    NOT NULL DEFAULT 'en',          -- UI language: 'en' | 'zh'
    disabled      INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- Browser login sessions. Only sha256(token) is stored; the raw token lives in the cookie.
CREATE TABLE sessions (
    token_hash   BLOB    PRIMARY KEY CHECK (length(token_hash) = 32),
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT    NOT NULL DEFAULT '',
    ip           TEXT    NOT NULL DEFAULT ''
) WITHOUT ROWID;
CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- Per-device credentials for OPDS (HTTP Basic) and KOReader sync.
-- Secrets are server-generated (>= 80 bits), so a fast hash is sufficient:
--   opds:   secret_hash = sha256(secret)
--   kosync: secret_hash = sha256(lower(hex(md5(secret))))   (KOReader sends md5(password))
CREATE TABLE app_passwords (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL CHECK (kind IN ('opds', 'kosync')),
    label        TEXT    NOT NULL,
    secret_hash  BLOB    NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
);
CREATE INDEX app_passwords_user_kind ON app_passwords (user_id, kind);

-- ---------------------------------------------------------------------------
-- Server configuration
-- ---------------------------------------------------------------------------

CREATE TABLE server_settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL CHECK (json_valid(value)),
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE metadata_providers (
    provider   TEXT    PRIMARY KEY CHECK (provider IN ('openlibrary', 'googlebooks', 'neodb', 'hardcover')),
    enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    api_token  TEXT,                                       -- write-only via API; required for neodb/hardcover
    base_url   TEXT,                                       -- override, e.g. a self-chosen NeoDB instance
    priority   INTEGER NOT NULL,                           -- lower = shown first
    updated_at INTEGER NOT NULL,
    CHECK (enabled = 0 OR provider IN ('openlibrary', 'googlebooks') OR api_token IS NOT NULL)
) WITHOUT ROWID;

INSERT INTO metadata_providers (provider, enabled, api_token, priority, updated_at) VALUES
    ('openlibrary', 1, NULL, 10, CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    ('googlebooks', 1, NULL, 20, CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    ('neodb',       0, NULL, 30, CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    ('hardcover',   0, NULL, 40, CAST(unixepoch('subsec') * 1000 AS INTEGER));

-- ---------------------------------------------------------------------------
-- Libraries & access control
-- ---------------------------------------------------------------------------

CREATE TABLE libraries (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL COLLATE NOCASE UNIQUE,
    slug       TEXT    NOT NULL UNIQUE CHECK (slug GLOB '[a-z0-9]*' AND slug NOT GLOB '*[^a-z0-9-]*'),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Admins implicitly see every library; rows here are for role = 'user'.
CREATE TABLE library_access (
    library_id INTEGER NOT NULL REFERENCES libraries (id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (library_id, user_id)
) WITHOUT ROWID;
CREATE INDEX library_access_user_id ON library_access (user_id, library_id);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

CREATE TABLE authors (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL COLLATE NOCASE UNIQUE,
    sort_name  TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE series (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT,
    created_at  INTEGER NOT NULL
);

CREATE TABLE tags (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL COLLATE NOCASE UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE books (
    id             INTEGER PRIMARY KEY,
    library_id     INTEGER NOT NULL REFERENCES libraries (id) ON DELETE RESTRICT,
    title          TEXT    NOT NULL,
    sort_title     TEXT    NOT NULL,
    subtitle       TEXT,
    description    TEXT,                                   -- may contain HTML; sanitized on render
    language       TEXT,                                   -- BCP 47, e.g. 'zh-Hans', 'en'
    publisher      TEXT,
    published_date TEXT CHECK (published_date IS NULL OR published_date GLOB '[0-9][0-9][0-9][0-9]*'),
    page_count     INTEGER CHECK (page_count IS NULL OR page_count > 0),
    series_id      INTEGER REFERENCES series (id) ON DELETE SET NULL,
    series_index   REAL CHECK (series_index IS NULL OR series_index >= 0),  -- decimal, e.g. 1.5
    cover_sha256   TEXT CHECK (cover_sha256 IS NULL OR length(cover_sha256) = 64),
    cover_source   TEXT,                                   -- 'file' | 'pdfjs' | 'upload' | provider name
    added_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX books_library_sort_title ON books (library_id, sort_title);
CREATE INDEX books_library_created_at ON books (library_id, created_at);
CREATE INDEX books_series ON books (series_id, series_index) WHERE series_id IS NOT NULL;

CREATE TABLE book_authors (
    book_id   INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES authors (id) ON DELETE RESTRICT,
    role      TEXT    NOT NULL DEFAULT 'author' CHECK (role IN ('author', 'translator', 'editor', 'illustrator')),
    position  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_id, author_id, role)
) WITHOUT ROWID;
CREATE INDEX book_authors_author_id ON book_authors (author_id, book_id);

CREATE TABLE book_tags (
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX book_tags_tag_id ON book_tags (tag_id, book_id);

CREATE TABLE book_identifiers (
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    scheme  TEXT    NOT NULL CHECK (scheme IN ('isbn13', 'isbn10', 'asin', 'doi', 'uuid',
                                               'openlibrary', 'googlebooks', 'neodb', 'hardcover', 'douban')),
    value   TEXT    NOT NULL,
    PRIMARY KEY (book_id, scheme, value)
) WITHOUT ROWID;
CREATE INDEX book_identifiers_lookup ON book_identifiers (scheme, value);

-- Which source each edited field was taken from (per-field merge in the edit UI).
CREATE TABLE book_field_sources (
    book_id      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    field        TEXT    NOT NULL CHECK (field IN ('title', 'subtitle', 'authors', 'description', 'language',
                                                   'publisher', 'published_date', 'page_count', 'series',
                                                   'tags', 'identifiers', 'cover')),
    source       TEXT    NOT NULL,                         -- 'file' | 'manual' | provider name
    source_ref   TEXT,                                     -- provider's record id
    chosen_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    chosen_at    INTEGER NOT NULL,
    PRIMARY KEY (book_id, field)
) WITHOUT ROWID;

-- One row per physical file. Content-addressed: stored at files/<sha[0:2]>/<sha>.<format>.
-- sha256 is globally unique => duplicate uploads are detected before insert.
CREATE TABLE book_files (
    id                INTEGER PRIMARY KEY,
    book_id           INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    sha256            TEXT    NOT NULL UNIQUE CHECK (length(sha256) = 64),
    format            TEXT    NOT NULL CHECK (format IN ('epub', 'pdf', 'mobi', 'azw3', 'fb2', 'fbz', 'cbz')),
    size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0),
    original_filename TEXT    NOT NULL,
    koreader_md5      TEXT CHECK (koreader_md5 IS NULL OR length(koreader_md5) = 32),  -- KOReader partial MD5
    created_at        INTEGER NOT NULL
);
CREATE INDEX book_files_book_id ON book_files (book_id);
CREATE INDEX book_files_koreader_md5 ON book_files (koreader_md5) WHERE koreader_md5 IS NOT NULL;

-- Per-user hide list (e.g. a child account), managed by admins.
CREATE TABLE book_hidden (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id    INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    hidden_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
) WITHOUT ROWID;
CREATE INDEX book_hidden_book_id ON book_hidden (book_id);

-- ---------------------------------------------------------------------------
-- Shelves
-- ---------------------------------------------------------------------------

CREATE TABLE shelves (
    id          INTEGER PRIMARY KEY,
    kind        TEXT    NOT NULL CHECK (kind IN ('private', 'shared')),
    owner_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,  -- NULL for shared shelves
    name        TEXT    NOT NULL,
    description TEXT,
    created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    CHECK ((kind = 'private') = (owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX shelves_private_name ON shelves (owner_id, name COLLATE NOCASE) WHERE kind = 'private';
CREATE UNIQUE INDEX shelves_shared_name ON shelves (name COLLATE NOCASE) WHERE kind = 'shared';

CREATE TABLE shelf_books (
    shelf_id INTEGER NOT NULL REFERENCES shelves (id) ON DELETE CASCADE,
    book_id  INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    added_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (shelf_id, book_id)
) WITHOUT ROWID;
CREATE INDEX shelf_books_book_id ON shelf_books (book_id);

-- ---------------------------------------------------------------------------
-- Per-user reading data (synced; last-write-wins on updated_at)
-- ---------------------------------------------------------------------------

-- Global monotonic change counter. Every synced write takes the next value as its `rev`;
-- clients pull "everything for me with rev > cursor".
CREATE TABLE sync_counter (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL
);
INSERT INTO sync_counter (id, value) VALUES (1, 0);

CREATE TABLE user_books (
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id     INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    status      TEXT    NOT NULL DEFAULT 'unread'
                CHECK (status IN ('unread', 'want_to_read', 'reading', 'finished', 'abandoned')),
    rating      INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),  -- half-stars: 7 = 3.5 stars
    started_at  INTEGER,
    finished_at INTEGER,
    updated_at  INTEGER NOT NULL,                          -- LWW clock (client time, clamped)
    rev         INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
) WITHOUT ROWID;
CREATE INDEX user_books_user_rev ON user_books (user_id, rev);
CREATE INDEX user_books_user_status ON user_books (user_id, status);

-- Latest position per user+book across all devices (web and KOReader).
-- locator is only meaningful for book_file_id; other formats/devices fall back to percentage.
--   web EPUB-like: {"cfi": "...", "spine": 11}
--   web PDF:       {"page": 42}
--   koreader:      {"xpointer": "/body/DocFragment[12]/..."} or {"page": 42}
CREATE TABLE reading_progress (
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    book_file_id INTEGER REFERENCES book_files (id) ON DELETE SET NULL,
    source       TEXT    NOT NULL CHECK (source IN ('web', 'koreader')),
    locator      TEXT CHECK (locator IS NULL OR json_valid(locator)),
    percentage   REAL    NOT NULL CHECK (percentage BETWEEN 0 AND 1),
    device       TEXT    NOT NULL DEFAULT '',
    device_id    TEXT    NOT NULL DEFAULT '',
    updated_at   INTEGER NOT NULL,
    rev          INTEGER NOT NULL,
    PRIMARY KEY (user_id, book_id)
) WITHOUT ROWID;
CREATE INDEX reading_progress_user_rev ON reading_progress (user_id, rev);
CREATE INDEX reading_progress_user_updated ON reading_progress (user_id, updated_at DESC);

-- Raw KOReader sync records, keyed exactly as KOReader keys them (document digest).
-- Kept so KOReader<->KOReader sync round-trips byte-for-byte, and so unknown documents
-- (digest not in book_files) still sync like a plain kosync server.
CREATE TABLE kosync_progress (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    document   TEXT    NOT NULL CHECK (length(document) BETWEEN 1 AND 64),
    progress   TEXT    NOT NULL,
    percentage REAL    NOT NULL,
    device     TEXT    NOT NULL DEFAULT '',
    device_id  TEXT    NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, document)
) WITHOUT ROWID;

-- Client-created entities use a client-generated UUIDv7 `id` so offline creates are idempotent.
-- `seq` is a stable integer rowid for FTS external content.
CREATE TABLE highlights (
    seq          INTEGER PRIMARY KEY,
    id           TEXT    NOT NULL UNIQUE CHECK (length(id) = 36),
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    book_file_id INTEGER REFERENCES book_files (id) ON DELETE SET NULL,
    locator      TEXT    NOT NULL CHECK (json_valid(locator)),   -- {"cfi": ...} or {"page": n, "rects": [...]}
    position     REAL    NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 1),  -- book fraction, for ordering
    text         TEXT    NOT NULL DEFAULT '',
    color        TEXT    NOT NULL DEFAULT 'yellow',
    chapter      TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,                                       -- tombstone for sync
    rev          INTEGER NOT NULL
);
CREATE INDEX highlights_user_book ON highlights (user_id, book_id, position) WHERE deleted_at IS NULL;
CREATE INDEX highlights_user_rev ON highlights (user_id, rev);

CREATE TABLE notes (
    seq          INTEGER PRIMARY KEY,
    id           TEXT    NOT NULL UNIQUE CHECK (length(id) = 36),
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    highlight_id TEXT REFERENCES highlights (id) ON DELETE CASCADE,  -- NULL = book-level note
    body_md      TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    rev          INTEGER NOT NULL
);
CREATE INDEX notes_user_book ON notes (user_id, book_id) WHERE deleted_at IS NULL;
CREATE INDEX notes_highlight_id ON notes (highlight_id) WHERE highlight_id IS NOT NULL;
CREATE INDEX notes_user_rev ON notes (user_id, rev);

-- Synced reader/UI preferences. key examples: 'reader.epub', 'reader.pdf', 'reader.book.123', 'ui'.
CREATE TABLE user_settings (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL CHECK (json_valid(value)),
    updated_at INTEGER NOT NULL,
    rev        INTEGER NOT NULL,
    PRIMARY KEY (user_id, key)
) WITHOUT ROWID;
CREATE INDEX user_settings_user_rev ON user_settings (user_id, rev);

-- Append-only reading sessions for statistics (upload-only from clients; INSERT OR IGNORE on id).
CREATE TABLE reading_sessions (
    seq              INTEGER PRIMARY KEY,
    id               TEXT    NOT NULL UNIQUE CHECK (length(id) = 36),
    user_id          INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id          INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    source           TEXT    NOT NULL CHECK (source IN ('web', 'koreader')),
    device           TEXT    NOT NULL DEFAULT '',
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER NOT NULL,
    active_seconds   INTEGER NOT NULL CHECK (active_seconds >= 0),
    start_percentage REAL CHECK (start_percentage IS NULL OR start_percentage BETWEEN 0 AND 1),
    end_percentage   REAL CHECK (end_percentage IS NULL OR end_percentage BETWEEN 0 AND 1),
    pages_turned     INTEGER,
    created_at       INTEGER NOT NULL,
    CHECK (ended_at >= started_at)
);
CREATE INDEX reading_sessions_user_started ON reading_sessions (user_id, started_at);
CREATE INDEX reading_sessions_user_book ON reading_sessions (user_id, book_id, started_at);

-- ---------------------------------------------------------------------------
-- Import & metadata lookup
-- ---------------------------------------------------------------------------

CREATE TABLE import_jobs (
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
CREATE INDEX import_jobs_status_created ON import_jobs (status, created_at);
CREATE INDEX import_jobs_created ON import_jobs (created_at);

-- Normalized provider responses. request_key examples: 'isbn:9787536692930', 'q:三体|刘慈欣', 'id:OL123M'.
-- status: 200 = hit, 404 = negative cache, other = transient error (short TTL).
CREATE TABLE metadata_cache (
    provider       TEXT    NOT NULL,
    request_key    TEXT    NOT NULL,
    status         INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,                       -- bump to invalidate after normalizer changes
    response       TEXT    NOT NULL CHECK (json_valid(response)),
    fetched_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    PRIMARY KEY (provider, request_key)
) WITHOUT ROWID;
CREATE INDEX metadata_cache_expires_at ON metadata_cache (expires_at);

-- ---------------------------------------------------------------------------
-- Full-text search (trigram => CJK substring search; MATCH needs >= 3 chars,
-- shorter queries fall back to LIKE on the same tables). Maintained by the
-- application in the same transaction as the source rows (see docs/architecture/database.md).
-- ---------------------------------------------------------------------------

-- rowid = books.id
CREATE VIRTUAL TABLE books_fts USING fts5 (
    title, authors, series, tags, publisher, identifiers, description,
    tokenize = 'trigram remove_diacritics 1'
);
-- Persistent default ranking: title > identifiers > authors > series > tags > publisher = description.
INSERT INTO books_fts (books_fts, rank) VALUES ('rank', 'bm25(10.0, 6.0, 4.0, 3.0, 1.0, 8.0, 1.0)');

-- rowid = highlights.seq / notes.seq; user_id/book_id unindexed for filtering.
CREATE VIRTUAL TABLE highlights_fts USING fts5 (
    text, user_id UNINDEXED, book_id UNINDEXED,
    tokenize = 'trigram remove_diacritics 1'
);
CREATE VIRTUAL TABLE notes_fts USING fts5 (
    body, highlight_text, user_id UNINDEXED, book_id UNINDEXED,
    tokenize = 'trigram remove_diacritics 1'
);

-- +goose Down
DROP TABLE notes_fts;
DROP TABLE highlights_fts;
DROP TABLE books_fts;
DROP TABLE metadata_cache;
DROP TABLE import_jobs;
DROP TABLE reading_sessions;
DROP TABLE user_settings;
DROP TABLE notes;
DROP TABLE highlights;
DROP TABLE kosync_progress;
DROP TABLE reading_progress;
DROP TABLE user_books;
DROP TABLE sync_counter;
DROP TABLE shelf_books;
DROP TABLE shelves;
DROP TABLE book_hidden;
DROP TABLE book_files;
DROP TABLE book_field_sources;
DROP TABLE book_identifiers;
DROP TABLE book_tags;
DROP TABLE book_authors;
DROP TABLE books;
DROP TABLE tags;
DROP TABLE series;
DROP TABLE authors;
DROP TABLE library_access;
DROP TABLE libraries;
DROP TABLE metadata_providers;
DROP TABLE server_settings;
DROP TABLE app_passwords;
DROP TABLE sessions;
DROP TABLE users;
