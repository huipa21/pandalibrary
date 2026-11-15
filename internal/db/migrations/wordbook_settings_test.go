package migrations

import (
	"context"
	"testing"
)

func TestWordbookSettingsMigration(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	previous := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 22), DefaultOptions())
	if err := previous.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES (1, 'reader', 'x', 'user', 1, 1);
		INSERT INTO wordbooks(id, user_id, name, meaning_language, cover_color, created_at, updated_at) VALUES
		(1, 1, 'Existing', 'zh-Hant', 'forest', 'now', 'now'),
		(2, 1, 'Unspecified', '', '', 'now', 'now')`); err != nil {
		t.Fatal(err)
	}
	runner := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var languages, legacy, color string
	if err := databases.Writer.QueryRowContext(ctx, `SELECT meaning_languages, meaning_language, cover_color FROM wordbooks WHERE id = 1`).Scan(&languages, &legacy, &color); err != nil || languages != `["zh-Hant"]` || legacy != "zh-Hant" || color != "forest" {
		t.Fatalf("migration lost settings: %q %q %q %v", languages, legacy, color, err)
	}
	if err := databases.Writer.QueryRowContext(ctx, `SELECT meaning_languages FROM wordbooks WHERE id = 2`).Scan(&languages); err != nil || languages != "[]" {
		t.Fatalf("unspecified = %q %v", languages, err)
	}
	if _, err := databases.Writer.ExecContext(ctx, `UPDATE wordbooks SET cover_color = 'charcoal', meaning_languages = '["zh-Hant","ja"]' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{`null`, `{}`, `"en"`, `invalid`} {
		if _, err := databases.Writer.ExecContext(ctx, `UPDATE wordbooks SET meaning_languages = ? WHERE id = 1`, value); err == nil {
			t.Fatalf("accepted non-array %q", value)
		}
	}
	if err := runner.DownTo(ctx, 22); err != nil {
		t.Fatal(err)
	}
	var name string
	if err := databases.Writer.QueryRowContext(ctx, `SELECT name, meaning_language, cover_color FROM wordbooks WHERE id = 1`).Scan(&name, &legacy, &color); err != nil || name != "Existing" || legacy != "zh-Hant" || color != "" {
		t.Fatalf("rollback lost data: %q %q %q %v", name, legacy, color, err)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
}
