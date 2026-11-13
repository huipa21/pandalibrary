package migrations

import (
	"context"
	"fmt"
	"testing"
)

func TestLibraryFilesMigrationPreservesReaderReferences(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	previous := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 11), DefaultOptions())
	if err := previous.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (1, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (1, 'First', 'first', 1, 1), (2, 'Second', 'second', 1, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (1, 1, 'A', 'a', 1, 1), (2, 2, 'B', 'b', 1, 1)`,
		`INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at) VALUES (7, 1, printf('%064d', 1), 'epub', 10, 'a.epub', 1)`,
		`INSERT INTO reading_progress (user_id, book_id, book_file_id, source, percentage, updated_at, rev) VALUES (1, 1, 7, 'web', .25, 1, 1)`,
		`INSERT INTO highlights (id, user_id, book_id, book_file_id, locator, created_at, updated_at, rev) VALUES ('00000000-0000-7000-8000-000000000001', 1, 1, 7, '{}', 1, 1, 2)`,
		`INSERT INTO bookmarks (id, user_id, book_id, book_file_id, locator, created_at, updated_at, rev) VALUES ('00000000-0000-7000-8000-000000000002', 1, 1, 7, '{}', 1, 1, 3)`,
		`INSERT INTO page_annotations (id, user_id, book_id, book_file_id, kind, locator, data, created_at, updated_at, rev) VALUES ('00000000-0000-7000-8000-000000000003', 1, 1, 7, 'text', '{}', '{}', 1, 1, 4)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	checkReferences := func() {
		t.Helper()
		for _, table := range []string{"reading_progress", "highlights", "bookmarks", "page_annotations"} {
			var fileID int64
			if err := databases.Reader.QueryRowContext(ctx, fmt.Sprintf("SELECT book_file_id FROM %s", table)).Scan(&fileID); err != nil || fileID != 7 {
				t.Fatalf("%s file reference = %d, %v", table, fileID, err)
			}
		}
	}
	latest := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := latest.Up(ctx); err != nil {
		t.Fatal(err)
	}
	checkReferences()
	if err := latest.DownTo(ctx, 11); err != nil {
		t.Fatal(err)
	}
	checkReferences()
	if err := latest.Up(ctx); err != nil {
		t.Fatal(err)
	}
	checkReferences()

	const duplicate = `INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at) VALUES (?, ?, printf('%064d', 1), 'epub', 10, 'copy.epub', 1)`
	if _, err := databases.Writer.ExecContext(ctx, duplicate, 8, 2); err != nil {
		t.Fatalf("same bytes in another library: %v", err)
	}
	if _, err := databases.Writer.ExecContext(ctx, duplicate, 9, 2); err == nil {
		t.Fatal("duplicate file on the same book was accepted")
	}
	if err := latest.DownTo(ctx, 11); err == nil {
		t.Fatal("downgrade with duplicate hashes must fail without discarding copies")
	}
	checkReferences()
	var count int
	if err := databases.Reader.QueryRowContext(ctx, "SELECT count(*) FROM book_files").Scan(&count); err != nil || count != 2 {
		t.Fatalf("files after rejected downgrade = %d, %v", count, err)
	}
}
