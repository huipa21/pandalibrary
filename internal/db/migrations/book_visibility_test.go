package migrations

import (
	"context"
	"database/sql"
	"testing"
)

func TestVisibilityMigrationPreservesLegacyAndOrphanPrivacy(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	old := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 9), DefaultOptions())
	if err := old.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.Exec(`INSERT INTO users (id,username,password_hash,role,created_at,updated_at) VALUES (1,'owner','x','admin',1,1);
		INSERT INTO libraries (id,name,slug,created_at,updated_at) VALUES (1,'Main','main',1,1);
		INSERT INTO books (id,library_id,title,sort_title,added_by,created_at,updated_at) VALUES (1,1,'Legacy','legacy',1,1,1)`); err != nil {
		t.Fatal(err)
	}
	runner := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var owner sql.NullInt64
	var visibility string
	if err := databases.Writer.QueryRow(`SELECT owner_id,visibility FROM books WHERE id=1`).Scan(&owner, &visibility); err != nil || owner.Valid || visibility != "library" {
		t.Fatalf("legacy owner=%v visibility=%s err=%v", owner, visibility, err)
	}
	if _, err := databases.Writer.Exec(`UPDATE books SET owner_id=1,visibility='private' WHERE id=1; DELETE FROM users WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if err := databases.Writer.QueryRow(`SELECT owner_id,visibility FROM books WHERE id=1`).Scan(&owner, &visibility); err != nil || owner.Valid || visibility != "private" {
		t.Fatalf("orphan owner=%v visibility=%s err=%v", owner, visibility, err)
	}
}
