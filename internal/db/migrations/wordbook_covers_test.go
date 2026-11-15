package migrations

import (
	"context"
	"testing"
)

func TestWordbookCoverMigration(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	previous := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 17), DefaultOptions())
	if err := previous.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES (1, 'reader', 'x', 'user', 1, 1);
		INSERT INTO wordbooks(id, user_id, name, created_at, updated_at) VALUES (1, 1, 'Existing', 'now', 'now')`); err != nil {
		t.Fatal(err)
	}
	runner := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var color, cover string
	if err := databases.Writer.QueryRowContext(ctx, `SELECT cover_color, cover_image FROM wordbooks WHERE id = 1`).Scan(&color, &cover); err != nil || color != "" || cover != "" {
		t.Fatalf("existing cover defaults: %q %q %v", color, cover, err)
	}
	for _, query := range []string{
		`UPDATE wordbooks SET cover_color = 'blue' WHERE id = 1`,
		`UPDATE wordbooks SET cover_image = printf('%0819224d', 1) WHERE id = 1`,
		`UPDATE wordbooks SET cover_color = NULL WHERE id = 1`,
		`UPDATE wordbooks SET cover_image = NULL WHERE id = 1`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, query); err == nil {
			t.Fatalf("constraint accepted %s", query)
		}
	}
	if _, err := databases.Writer.ExecContext(ctx, `UPDATE wordbooks SET cover_color = 'slate-teal' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if err := runner.DownTo(ctx, 17); err != nil {
		t.Fatal(err)
	}
	var name string
	if err := databases.Writer.QueryRowContext(ctx, `SELECT name FROM wordbooks WHERE id = 1`).Scan(&name); err != nil || name != "Existing" {
		t.Fatalf("rollback lost wordbook: %q %v", name, err)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
}
