package search

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

func TestIndexBookUsesCurrentMetadataAndTransaction(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "search.db")
	databases, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close databases: %v", err)
		}
	})
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), migrations.Options{AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (1, 'Main', 'main', 1, 1)`,
		`INSERT INTO series (id, name, created_at) VALUES (1, 'Saga', 1)`,
		`INSERT INTO authors (id, name, sort_name, created_at) VALUES (1, 'First', 'First', 1), (2, 'Second', 'Second', 1)`,
		`INSERT INTO tags (id, name, created_at) VALUES (1, 'Zebra', 1), (2, 'Alpha', 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, series_id, publisher, description, created_at, updated_at)
			VALUES (1, 1, 'Original Title', 'original title', 1, 'Publisher', 'Description text', 1, 1)`,
		`INSERT INTO book_authors (book_id, author_id, role, position) VALUES (1, 1, 'author', 1), (1, 2, 'translator', 0)`,
		`INSERT INTO book_tags (book_id, tag_id) VALUES (1, 1), (1, 2)`,
		`INSERT INTO book_identifiers (book_id, scheme, value) VALUES (1, 'isbn13', '978123')`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.WithTx(ctx, databases.Writer, func(tx *sql.Tx) error { return IndexBook(ctx, tx, 1) }); err != nil {
		t.Fatal(err)
	}
	var title, authors, series, tags, publisher, identifiers, description string
	if err := databases.Reader.QueryRowContext(ctx, `
		SELECT title, authors, series, tags, publisher, identifiers, description FROM books_fts WHERE rowid = 1`).
		Scan(&title, &authors, &series, &tags, &publisher, &identifiers, &description); err != nil {
		t.Fatal(err)
	}
	if title != "Original Title" || authors != "Second First" || series != "Saga" ||
		tags != "Alpha Zebra" || publisher != "Publisher" || identifiers != "978123" || description != "Description text" {
		t.Fatalf("indexed metadata = %q %q %q %q %q %q %q", title, authors, series, tags, publisher, identifiers, description)
	}
	rollback := errors.New("roll back")
	err = db.WithTx(ctx, databases.Writer, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE books SET title = 'Changed Title' WHERE id = 1`); err != nil {
			return err
		}
		if err := IndexBook(ctx, tx, 1); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("rollback error = %v", err)
	}
	if err := databases.Reader.QueryRowContext(ctx, `SELECT title FROM books_fts WHERE rowid = 1`).Scan(&title); err != nil || title != "Original Title" {
		t.Fatalf("index after rollback = %q, %v", title, err)
	}
	if err := db.WithTx(ctx, databases.Writer, func(tx *sql.Tx) error { return IndexBook(ctx, tx, 999) }); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("index missing book = %v", err)
	}
	if err := IndexBook(ctx, nil, 1); err == nil {
		t.Fatal("index accepted a nil transaction")
	}
}
