package migrations

import (
	"context"
	"encoding/json"
	"testing"
)

func TestCollectionRulesMigrationPreservesLegacyShelves(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	previous := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 10), DefaultOptions())
	if err := previous.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (1, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (10, 'Main', 'main', 1, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (101, 10, 'A', 'a', 1, 1)`,
		`INSERT INTO shelves (id, kind, owner_id, name, mode, rules, created_at, updated_at) VALUES
			(1, 'private', 1, 'Manual', 'manual', NULL, 1, 1),
			(2, 'private', 1, 'Automatic', 'automatic', '{"match":"all","conditions":[{"field":"title","op":"contains","value":"A"}]}', 1, 1)`,
		`INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at) VALUES (1, 101, 0, 1, 1)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	latest := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := latest.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := databases.Writer.QueryRowContext(ctx, `SELECT rule_groups FROM shelves WHERE id = 2`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var groups []struct {
		ID    string          `json:"id"`
		Name  string          `json:"name"`
		Rules json.RawMessage `json:"rules"`
	}
	if err := json.Unmarshal([]byte(stored), &groups); err != nil || len(groups) != 1 || groups[0].ID != "legacy" || groups[0].Name != "Rules" {
		t.Fatalf("migrated legacy groups = %s, %v", stored, err)
	}
	var oldRules string
	if err := databases.Writer.QueryRowContext(ctx, `SELECT rules FROM shelves WHERE id = 2`).Scan(&oldRules); err != nil {
		t.Fatal(err)
	}
	if string(groups[0].Rules) != oldRules {
		t.Fatalf("migrated rules = %s, want %s", groups[0].Rules, oldRules)
	}
	if err := databases.Writer.QueryRowContext(ctx, `SELECT rule_groups FROM shelves WHERE id = 1`).Scan(&stored); err != nil || stored != "[]" {
		t.Fatalf("manual groups = %s, %v", stored, err)
	}
	var count int
	if err := databases.Writer.QueryRowContext(ctx, `SELECT count(*) FROM shelf_books WHERE shelf_id = 1 AND book_id = 101 AND position = 0`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("preserved manual membership = %d, %v", count, err)
	}
}
