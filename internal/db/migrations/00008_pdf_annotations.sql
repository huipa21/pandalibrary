-- +goose Up
ALTER TABLE highlights ADD COLUMN style TEXT NOT NULL DEFAULT 'highlight'
    CHECK (style IN ('highlight', 'underline', 'strikeout'));

CREATE TABLE annotation_assets (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    sha256     TEXT    NOT NULL CHECK (length(sha256) = 64),
    media_type TEXT    NOT NULL CHECK (media_type IN ('image/png', 'image/jpeg', 'image/webp')),
    size       INTEGER NOT NULL CHECK (size BETWEEN 1 AND 5242880),
    width      INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
    height     INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, sha256)
) WITHOUT ROWID;

CREATE TABLE page_annotations (
    seq          INTEGER PRIMARY KEY,
    id           TEXT    NOT NULL UNIQUE CHECK (length(id) = 36),
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    book_id      INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    book_file_id INTEGER REFERENCES book_files (id) ON DELETE SET NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('text', 'ink', 'image')),
    locator      TEXT    NOT NULL CHECK (json_valid(locator)),
    position     REAL    NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 1),
    data         TEXT    NOT NULL CHECK (json_valid(data)),
    asset_sha256 TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER,
    rev          INTEGER NOT NULL
);
CREATE INDEX page_annotations_user_book ON page_annotations (user_id, book_id, position) WHERE deleted_at IS NULL;
CREATE INDEX page_annotations_user_rev ON page_annotations (user_id, rev);
CREATE INDEX page_annotations_asset ON page_annotations (user_id, asset_sha256) WHERE asset_sha256 IS NOT NULL;

-- +goose Down
DROP TABLE page_annotations;
DROP TABLE annotation_assets;
ALTER TABLE highlights DROP COLUMN style;
