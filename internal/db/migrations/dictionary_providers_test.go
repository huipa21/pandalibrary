package migrations

import (
	"context"
	"database/sql"
	"testing"
)

func TestDictionaryProvidersMigration(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	previous := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 24), DefaultOptions())
	if err := previous.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx,
		`UPDATE dictionary_settings SET base_url = 'https://dict.example/api', api_key = 'secret', updated_at = 42 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	runner := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var base, key string
	var enabled, updatedAt int64
	if err := databases.Writer.QueryRowContext(ctx,
		`SELECT base_url, api_key, enabled, updated_at FROM dictionary_providers WHERE kind = 'custom'`,
	).Scan(&base, &key, &enabled, &updatedAt); err != nil || base != "https://dict.example/api" || key != "secret" || enabled != 1 || updatedAt != 42 {
		t.Fatalf("custom provider = %q %q %d %d %v", base, key, enabled, updatedAt, err)
	}
	var presets int
	if err := databases.Writer.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM dictionary_providers WHERE kind IN ('mw-collegiate', 'mw-thesaurus') AND enabled = 0 AND api_key IS NULL AND base_url IS NULL`,
	).Scan(&presets); err != nil || presets != 2 {
		t.Fatalf("disabled presets = %d %v", presets, err)
	}
	if _, err := databases.Writer.ExecContext(ctx, `UPDATE dictionary_providers SET enabled = 1 WHERE kind = 'mw-collegiate'`); err == nil {
		t.Fatal("enabled a preset without an API key")
	}
	if _, err := databases.Writer.ExecContext(ctx,
		`INSERT INTO dictionary_providers (kind, name, enabled, priority, created_at, updated_at) VALUES ('mw-thesaurus', 'Duplicate', 0, 1, 1, 1)`); err == nil {
		t.Fatal("inserted a duplicate preset")
	}
	if err := runner.DownTo(ctx, 24); err != nil {
		t.Fatal(err)
	}
	var restored sql.NullString
	if err := databases.Writer.QueryRowContext(ctx, `SELECT base_url, api_key FROM dictionary_settings WHERE id = 1`).Scan(&restored, &key); err != nil ||
		restored.String != "https://dict.example/api" || key != "secret" {
		t.Fatalf("rollback = %v %q %v", restored, key, err)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
}
