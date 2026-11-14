package migrations

import (
	"context"
	"testing"
)

func TestMetadataFieldsMigration(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	previous := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 14), DefaultOptions())
	if err := previous.Up(ctx); err != nil {
		t.Fatal(err)
	}
	exec := func(statement string, args ...any) error {
		_, err := databases.Writer.ExecContext(ctx, statement, args...)
		return err
	}
	for _, statement := range []string{
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (1, 'Library', 'library', 1, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (1, 1, 'Book', 'book', 1, 1)`,
		`INSERT INTO book_identifiers (book_id, scheme, value) VALUES (1, 'isbn13', '9780306406157')`,
		`INSERT INTO book_field_sources (book_id, field, source, chosen_at) VALUES (1, 'title', 'manual', 1)`,
	} {
		if err := exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	latest := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := latest.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := databases.Reader.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM book_identifiers WHERE value = '9780306406157') + (SELECT count(*) FROM book_field_sources WHERE field = 'title')`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("preserved rows = %d, %v", count, err)
	}
	var indexes int
	if err := databases.Reader.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'book_identifiers_lookup'`).Scan(&indexes); err != nil || indexes != 1 {
		t.Fatalf("identifier index = %d, %v", indexes, err)
	}
	for _, valid := range []string{
		`INSERT INTO book_identifiers (book_id, scheme, value) VALUES (1, 'goodreads', '123')`,
		`INSERT INTO book_field_sources (book_id, field, source, chosen_at) VALUES (1, 'genres', 'manual', 1)`,
		`INSERT INTO book_field_sources (book_id, field, source, chosen_at) VALUES (1, 'ratings', 'hardcover', 1)`,
		`INSERT INTO book_terms (book_id, kind, name, position) VALUES (1, 'genre', 'Fantasy', 0)`,
		`INSERT INTO book_ratings (book_id, provider, rating, rating_count) VALUES (1, 'hardcover', 4.5, 10)`,
		`UPDATE books SET age_rating = 13, content_rating = 'teen', series_total = 3 WHERE id = 1`,
	} {
		if err := exec(valid); err != nil {
			t.Fatalf("%s: %v", valid, err)
		}
	}
	for _, invalid := range []string{
		`INSERT INTO book_terms (book_id, kind, name, position) VALUES (1, 'genre', 'fantasy', 1)`,
		`INSERT INTO book_terms (book_id, kind, name, position) VALUES (1, 'topic', 'x', 0)`,
		`INSERT INTO book_ratings (book_id, provider, rating) VALUES (1, 'other', 5.5)`,
		`INSERT INTO book_ratings (book_id, provider, rating_count) VALUES (1, 'other', -1)`,
		`UPDATE books SET age_rating = 22 WHERE id = 1`,
		`UPDATE books SET content_rating = 'kids' WHERE id = 1`,
		`UPDATE books SET series_total = 0 WHERE id = 1`,
	} {
		if err := exec(invalid); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
	if err := latest.DownTo(ctx, 14); err != nil {
		t.Fatal(err)
	}
	if err := databases.Reader.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM book_identifiers) + (SELECT count(*) FROM book_field_sources)`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("rows after downgrade = %d, %v", count, err)
	}
	if err := latest.Up(ctx); err != nil {
		t.Fatal(err)
	}
}
