package migrations

import (
	"context"
	"strings"
	"testing"
)

func TestBookReviewsMigration(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	prior := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 6), DefaultOptions())
	if err := prior.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (1, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (1, 'Main', 'main', 1, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (1, 1, 'Book', 'book', 1, 1)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	runner := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO book_reviews (book_id, user_id, body, created_at, updated_at) VALUES (1, 1, ?, 1, 1)`
	for _, body := range []string{"", " ", strings.Repeat("界", 10001)} {
		if _, err := databases.Writer.ExecContext(ctx, insert, body); err == nil {
			t.Fatal("invalid review accepted")
		}
	}
	if _, err := databases.Writer.ExecContext(ctx, insert, strings.Repeat("界", 10000)); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx, insert, "duplicate"); err == nil {
		t.Fatal("duplicate user/book review accepted")
	}
	if err := runner.DownTo(ctx, 6); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx, "SELECT * FROM book_reviews"); err == nil {
		t.Fatal("review table survived rollback")
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx, insert, "after re-up"); err != nil {
		t.Fatal(err)
	}
}
