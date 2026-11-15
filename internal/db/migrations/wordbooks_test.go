package migrations

import (
	"context"
	"testing"
)

func TestWordbookMigrationConstraintsAndRollback(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	previous := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 15), DefaultOptions())
	if err := previous.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES (1, 'reader', 'x', 'user', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	runner := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	exec := func(query string) error { _, err := databases.Writer.ExecContext(ctx, query); return err }
	if err := exec(`INSERT INTO wordbooks(id, user_id, name, is_default, created_at, updated_at) VALUES (1, 1, 'Default', 1, 'now', 'now')`); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`INSERT INTO wordbooks(user_id, name, is_default, created_at, updated_at) VALUES (1, 'Duplicate', 1, 'now', 'now')`,
		`UPDATE wordbooks SET archived = 1 WHERE id = 1`,
		`INSERT INTO wordbook_entries(wordbook_id, kind, text, dictionary_entries, source, created_at, updated_at) VALUES (1, 'invalid', 'text', '[]', '{}', 'now', 'now')`,
	} {
		if err := exec(query); err == nil {
			t.Fatalf("constraint accepted %s", query)
		}
	}
	if err := exec(`INSERT INTO wordbook_entries(wordbook_id, kind, text, dictionary_entries, source, created_at, updated_at) VALUES (1, 'word', 'text', '[]', '{"book_id":99999}', 'now', 'now')`); err != nil {
		t.Fatal(err)
	}
	if err := exec(`DELETE FROM users WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := databases.Writer.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM wordbooks) + (SELECT count(*) FROM wordbook_entries)`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("user deletion did not cascade: %d %v", count, err)
	}
	if err := runner.DownTo(ctx, 15); err != nil {
		t.Fatal(err)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
}
