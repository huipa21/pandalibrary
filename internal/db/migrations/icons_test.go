package migrations

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestNavigationIconsMigration(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	previous := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 13), DefaultOptions())
	if err := previous.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (1, 'Existing library', 'existing', 1, 1)`,
		`INSERT INTO shelves (id, kind, name, created_at, updated_at) VALUES (1, 'shared', 'Existing shelf', 1, 1)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	latest := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := latest.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"libraries", "shelves"} {
		var icon string
		query := fmt.Sprintf("SELECT icon FROM %s WHERE id = 1", table)
		if err := databases.Reader.QueryRowContext(ctx, query).Scan(&icon); err != nil || icon != "" {
			t.Fatalf("%s existing icon = %q, %v", table, icon, err)
		}
		update := fmt.Sprintf("UPDATE %s SET icon = ? WHERE id = 1", table)
		for _, invalid := range []any{nil, strings.Repeat("a", 65)} {
			if _, err := databases.Writer.ExecContext(ctx, update, invalid); err == nil {
				t.Fatalf("%s accepted invalid icon %v", table, invalid)
			}
		}
		if _, err := databases.Writer.ExecContext(ctx, update, "book-open"); err != nil {
			t.Fatal(err)
		}
		if err := databases.Reader.QueryRowContext(ctx, query).Scan(&icon); err != nil || icon != "book-open" {
			t.Fatalf("%s updated icon = %q, %v", table, icon, err)
		}
	}
	if err := latest.DownTo(ctx, 13); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"libraries", "shelves"} {
		var name string
		if err := databases.Reader.QueryRowContext(ctx, fmt.Sprintf("SELECT name FROM %s WHERE id = 1", table)).Scan(&name); err != nil || !strings.HasPrefix(name, "Existing ") {
			t.Fatalf("%s name after downgrade = %q, %v", table, name, err)
		}
	}
	if err := latest.Up(ctx); err != nil {
		t.Fatal(err)
	}
}
