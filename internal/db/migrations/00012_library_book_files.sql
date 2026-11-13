-- +goose Up

-- Identical bytes may belong to separate books in different physical libraries.
-- Immutable blobs remain shared; file IDs and all reader references are preserved.
CREATE TABLE book_files_v12 (
    id                INTEGER PRIMARY KEY,
    book_id           INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    sha256            TEXT NOT NULL CHECK (length(sha256) = 64),
    format            TEXT NOT NULL CHECK (format IN ('epub', 'pdf', 'mobi', 'azw3', 'fb2', 'fbz', 'cbz')),
    size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0),
    original_filename TEXT NOT NULL,
    koreader_md5      TEXT CHECK (koreader_md5 IS NULL OR length(koreader_md5) = 32),
    created_at        INTEGER NOT NULL,
    UNIQUE (book_id, sha256)
);
INSERT INTO book_files_v12 SELECT * FROM book_files;

-- DROP TABLE invokes ON DELETE SET NULL even inside a transaction.
CREATE TEMP TABLE saved_file_progress AS SELECT user_id, book_id, book_file_id FROM reading_progress WHERE book_file_id IS NOT NULL;
CREATE TEMP TABLE saved_file_highlights AS SELECT seq, book_file_id FROM highlights WHERE book_file_id IS NOT NULL;
CREATE TEMP TABLE saved_file_bookmarks AS SELECT seq, book_file_id FROM bookmarks WHERE book_file_id IS NOT NULL;
CREATE TEMP TABLE saved_file_annotations AS SELECT seq, book_file_id FROM page_annotations WHERE book_file_id IS NOT NULL;

DROP TABLE book_files;
ALTER TABLE book_files_v12 RENAME TO book_files;
CREATE INDEX book_files_book_id ON book_files (book_id);
CREATE INDEX book_files_sha256 ON book_files (sha256);
CREATE INDEX book_files_koreader_md5 ON book_files (koreader_md5) WHERE koreader_md5 IS NOT NULL;

UPDATE reading_progress SET book_file_id = s.book_file_id FROM saved_file_progress s WHERE reading_progress.user_id = s.user_id AND reading_progress.book_id = s.book_id;
UPDATE highlights SET book_file_id = s.book_file_id FROM saved_file_highlights s WHERE highlights.seq = s.seq;
UPDATE bookmarks SET book_file_id = s.book_file_id FROM saved_file_bookmarks s WHERE bookmarks.seq = s.seq;
UPDATE page_annotations SET book_file_id = s.book_file_id FROM saved_file_annotations s WHERE page_annotations.seq = s.seq;
DROP TABLE saved_file_progress;
DROP TABLE saved_file_highlights;
DROP TABLE saved_file_bookmarks;
DROP TABLE saved_file_annotations;

-- +goose Down

-- If cross-library duplicates exist, this insert fails and the transaction
-- leaves the current schema/data untouched instead of discarding copies.
CREATE TABLE book_files_v11 (
    id                INTEGER PRIMARY KEY,
    book_id           INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    sha256            TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
    format            TEXT NOT NULL CHECK (format IN ('epub', 'pdf', 'mobi', 'azw3', 'fb2', 'fbz', 'cbz')),
    size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0),
    original_filename TEXT NOT NULL,
    koreader_md5      TEXT CHECK (koreader_md5 IS NULL OR length(koreader_md5) = 32),
    created_at        INTEGER NOT NULL
);
INSERT INTO book_files_v11 SELECT * FROM book_files;

CREATE TEMP TABLE saved_file_progress AS SELECT user_id, book_id, book_file_id FROM reading_progress WHERE book_file_id IS NOT NULL;
CREATE TEMP TABLE saved_file_highlights AS SELECT seq, book_file_id FROM highlights WHERE book_file_id IS NOT NULL;
CREATE TEMP TABLE saved_file_bookmarks AS SELECT seq, book_file_id FROM bookmarks WHERE book_file_id IS NOT NULL;
CREATE TEMP TABLE saved_file_annotations AS SELECT seq, book_file_id FROM page_annotations WHERE book_file_id IS NOT NULL;

DROP TABLE book_files;
ALTER TABLE book_files_v11 RENAME TO book_files;
CREATE INDEX book_files_book_id ON book_files (book_id);
CREATE INDEX book_files_koreader_md5 ON book_files (koreader_md5) WHERE koreader_md5 IS NOT NULL;

UPDATE reading_progress SET book_file_id = s.book_file_id FROM saved_file_progress s WHERE reading_progress.user_id = s.user_id AND reading_progress.book_id = s.book_id;
UPDATE highlights SET book_file_id = s.book_file_id FROM saved_file_highlights s WHERE highlights.seq = s.seq;
UPDATE bookmarks SET book_file_id = s.book_file_id FROM saved_file_bookmarks s WHERE bookmarks.seq = s.seq;
UPDATE page_annotations SET book_file_id = s.book_file_id FROM saved_file_annotations s WHERE page_annotations.seq = s.seq;
DROP TABLE saved_file_progress;
DROP TABLE saved_file_highlights;
DROP TABLE saved_file_bookmarks;
DROP TABLE saved_file_annotations;
