-- +goose Up
ALTER TABLE books ADD COLUMN age_rating INTEGER
    CHECK (age_rating IS NULL OR age_rating BETWEEN 0 AND 21);
ALTER TABLE books ADD COLUMN content_rating TEXT
    CHECK (content_rating IS NULL OR content_rating IN ('everyone', 'teen', 'mature', 'adult'));
ALTER TABLE books ADD COLUMN series_total INTEGER
    CHECK (series_total IS NULL OR series_total >= 1);

-- Free-form genre and mood labels, ordered per book.
CREATE TABLE book_terms (
    book_id  INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    kind     TEXT    NOT NULL CHECK (kind IN ('genre', 'mood')),
    name     TEXT    NOT NULL COLLATE NOCASE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (book_id, kind, name)
) WITHOUT ROWID;

-- Community ratings reported by metadata providers, normalized to 0..5.
CREATE TABLE book_ratings (
    book_id      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    provider     TEXT    NOT NULL,
    rating       REAL CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
    rating_count INTEGER CHECK (rating_count IS NULL OR rating_count >= 0),
    PRIMARY KEY (book_id, provider)
) WITHOUT ROWID;

CREATE TABLE book_identifiers_v15 (
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    scheme  TEXT    NOT NULL CHECK (scheme IN ('isbn13', 'isbn10', 'asin', 'doi', 'uuid',
                                               'openlibrary', 'googlebooks', 'neodb', 'hardcover', 'douban',
                                               'goodreads')),
    value   TEXT    NOT NULL,
    PRIMARY KEY (book_id, scheme, value)
) WITHOUT ROWID;
INSERT INTO book_identifiers_v15 (book_id, scheme, value) SELECT book_id, scheme, value FROM book_identifiers;
DROP TABLE book_identifiers;
ALTER TABLE book_identifiers_v15 RENAME TO book_identifiers;
CREATE INDEX book_identifiers_lookup ON book_identifiers (scheme, value);

CREATE TABLE book_field_sources_v15 (
    book_id      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    field        TEXT    NOT NULL CHECK (field IN ('title', 'subtitle', 'authors', 'description', 'language',
                                                   'publisher', 'published_date', 'page_count', 'series',
                                                   'tags', 'genres', 'moods', 'age_rating', 'content_rating',
                                                   'ratings', 'identifiers', 'cover')),
    source       TEXT    NOT NULL,
    source_ref   TEXT,
    chosen_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    chosen_at    INTEGER NOT NULL,
    PRIMARY KEY (book_id, field)
) WITHOUT ROWID;
INSERT INTO book_field_sources_v15 (book_id, field, source, source_ref, chosen_by, chosen_at)
    SELECT book_id, field, source, source_ref, chosen_by, chosen_at FROM book_field_sources;
DROP TABLE book_field_sources;
ALTER TABLE book_field_sources_v15 RENAME TO book_field_sources;

-- +goose Down
CREATE TABLE book_field_sources_v14 (
    book_id      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    field        TEXT    NOT NULL CHECK (field IN ('title', 'subtitle', 'authors', 'description', 'language',
                                                   'publisher', 'published_date', 'page_count', 'series',
                                                   'tags', 'identifiers', 'cover')),
    source       TEXT    NOT NULL,
    source_ref   TEXT,
    chosen_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    chosen_at    INTEGER NOT NULL,
    PRIMARY KEY (book_id, field)
) WITHOUT ROWID;
INSERT INTO book_field_sources_v14 (book_id, field, source, source_ref, chosen_by, chosen_at)
    SELECT book_id, field, source, source_ref, chosen_by, chosen_at FROM book_field_sources
    WHERE field NOT IN ('genres', 'moods', 'age_rating', 'content_rating', 'ratings');
DROP TABLE book_field_sources;
ALTER TABLE book_field_sources_v14 RENAME TO book_field_sources;

CREATE TABLE book_identifiers_v14 (
    book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    scheme  TEXT    NOT NULL CHECK (scheme IN ('isbn13', 'isbn10', 'asin', 'doi', 'uuid',
                                               'openlibrary', 'googlebooks', 'neodb', 'hardcover', 'douban')),
    value   TEXT    NOT NULL,
    PRIMARY KEY (book_id, scheme, value)
) WITHOUT ROWID;
INSERT INTO book_identifiers_v14 (book_id, scheme, value)
    SELECT book_id, scheme, value FROM book_identifiers WHERE scheme <> 'goodreads';
DROP TABLE book_identifiers;
ALTER TABLE book_identifiers_v14 RENAME TO book_identifiers;
CREATE INDEX book_identifiers_lookup ON book_identifiers (scheme, value);

DROP TABLE book_ratings;
DROP TABLE book_terms;
ALTER TABLE books DROP COLUMN series_total;
ALTER TABLE books DROP COLUMN content_rating;
ALTER TABLE books DROP COLUMN age_rating;
