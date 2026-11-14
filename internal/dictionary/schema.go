package dictionary

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// SchemaVersion is stored in meta.schema_version. Importers rebuild data when it changes.
const SchemaVersion = "1"

const schema = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sources (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	license TEXT NOT NULL,
	url TEXT NOT NULL,
	entry_count INTEGER NOT NULL,
	imported_at INTEGER NOT NULL
) WITHOUT ROWID;
-- definitions is a JSON array of strings in the target language.
-- rank orders entries within a source; lower is more common/important.
CREATE TABLE IF NOT EXISTS entries (
	id INTEGER PRIMARY KEY,
	source_id TEXT NOT NULL,
	from_lang TEXT NOT NULL,
	to_lang TEXT NOT NULL,
	headword TEXT NOT NULL,
	reading TEXT NOT NULL DEFAULT '',
	pos TEXT NOT NULL DEFAULT '',
	definitions TEXT NOT NULL,
	rank INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS entries_source ON entries(source_id);
-- key is NormalizeKey(from_lang, ...) of a headword, reading, script variant or inflected form.
CREATE TABLE IF NOT EXISTS entry_keys (
	from_lang TEXT NOT NULL,
	to_lang TEXT NOT NULL,
	key TEXT NOT NULL,
	entry_id INTEGER NOT NULL,
	kind TEXT NOT NULL,
	PRIMARY KEY (from_lang, to_lang, key, entry_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS entry_keys_entry ON entry_keys(entry_id);
-- Traditional to Simplified Chinese mapping derived from CC-CEDICT; trad may be a word or a character.
CREATE TABLE IF NOT EXISTS zh_t2s (
	trad TEXT PRIMARY KEY,
	simp TEXT NOT NULL
) WITHOUT ROWID;
`

// Open opens the dictionary database. Read-only handles fail with os.ErrNotExist when the file is missing.
func Open(ctx context.Context, path string, writable bool) (*sql.DB, error) {
	if path == "" {
		return nil, errors.New("dictionary database path must not be empty")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve dictionary database path: %w", err)
	}
	if writable {
		if err := os.MkdirAll(filepath.Dir(absolute), 0o750); err != nil {
			return nil, fmt.Errorf("create dictionary directory: %w", err)
		}
	} else if _, err := os.Stat(absolute); err != nil {
		return nil, err
	}
	values := url.Values{}
	values.Add("_pragma", "journal_mode(WAL)")
	values.Add("_pragma", "synchronous(NORMAL)")
	values.Add("_pragma", "busy_timeout(5000)")
	values.Add("_pragma", "temp_store(MEMORY)")
	if writable {
		values.Set("_txlock", "immediate")
	} else {
		values.Add("_pragma", "query_only(ON)")
	}
	database, err := sql.Open("sqlite", absolute+"?"+values.Encode())
	if err != nil {
		return nil, err
	}
	if writable {
		database.SetMaxOpenConns(1)
	} else {
		database.SetMaxOpenConns(4)
	}
	if err := database.PingContext(ctx); err != nil {
		return nil, errors.Join(fmt.Errorf("open dictionary database: %w", err), database.Close())
	}
	if writable {
		if err := EnsureSchema(ctx, database); err != nil {
			return nil, errors.Join(err, database.Close())
		}
	}
	return database, nil
}

// EnsureSchema creates missing tables and records the schema version.
func EnsureSchema(ctx context.Context, database *sql.DB) error {
	if _, err := database.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("create dictionary schema: %w", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, SchemaVersion); err != nil {
		return fmt.Errorf("record dictionary schema version: %w", err)
	}
	return nil
}
