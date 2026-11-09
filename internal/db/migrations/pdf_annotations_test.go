package migrations

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"pandalibrary/internal/db"
)

func TestPDFAnnotationsMigrationUpgradeFromCopy(t *testing.T) {
	ctx := context.Background()
	original, path := openTestDB(t)
	v7 := newTestRunner(t, original.Writer, path, embeddedPrefixFS(t, 7), DefaultOptions())
	if err := v7.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (1, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (1, 'Main', 'main', 1, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (1, 1, 'Book', 'book', 1, 1)`,
		`INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
		 VALUES (1, 1, '` + strings.Repeat("a", 64) + `', 'pdf', 1, 'book.pdf', 1)`,
		`INSERT INTO highlights (id, user_id, book_id, book_file_id, locator, position, text, color, created_at, updated_at, rev)
		 VALUES ('018f0f7e-7b00-7000-8000-000000000001', 1, 1, 1, '{"type":"pdf","page":1}', 0.5, 'old', 'yellow', 10, 1234, 7)`,
		`UPDATE sync_counter SET value = 20 WHERE id = 1`,
	} {
		if _, err := original.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	copyPath := filepath.Join(t.TempDir(), "version7-copy.db")
	if _, err := original.Writer.ExecContext(ctx, "VACUUM INTO ?", copyPath); err != nil {
		t.Fatal(err)
	}
	copied, err := db.Open(ctx, copyPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := copied.Close(); err != nil {
			t.Errorf("close copied database: %v", err)
		}
	})
	runner := newTestRunner(t, copied.Writer, copyPath, embedded, DefaultOptions())
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	var style string
	var updatedAt, rev, counter int64
	if err := copied.Writer.QueryRowContext(ctx,
		`SELECT style, updated_at, rev FROM highlights WHERE user_id = 1`,
	).Scan(&style, &updatedAt, &rev); err != nil {
		t.Fatal(err)
	}
	if err := copied.Writer.QueryRowContext(ctx, `SELECT value FROM sync_counter WHERE id = 1`).Scan(&counter); err != nil {
		t.Fatal(err)
	}
	if style != "highlight" || updatedAt != 1234 || rev != 7 || counter != 20 {
		t.Fatalf("upgraded highlight = (%q, %d, %d), counter = %d", style, updatedAt, rev, counter)
	}

	assetSQL := `INSERT INTO annotation_assets (user_id, sha256, media_type, size, width, height, created_at)
		VALUES (1, ?, ?, ?, ?, ?, 1)`
	for _, test := range []struct {
		name                string
		hash, media         string
		size, width, height int
	}{
		{"hash length", "short", "image/png", 1, 1, 1},
		{"media type", strings.Repeat("a", 64), "image/gif", 1, 1, 1},
		{"empty asset", strings.Repeat("a", 64), "image/png", 0, 1, 1},
		{"oversized asset", strings.Repeat("a", 64), "image/png", 5242881, 1, 1},
		{"zero width", strings.Repeat("a", 64), "image/png", 1, 0, 1},
		{"large height", strings.Repeat("a", 64), "image/png", 1, 1, 8193},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := copied.Writer.ExecContext(ctx, assetSQL, test.hash, test.media, test.size, test.width, test.height); err == nil {
				t.Fatal("invalid annotation asset accepted")
			}
		})
	}
	hash := strings.Repeat("a", 64)
	if _, err := copied.Writer.ExecContext(ctx, assetSQL, hash, "image/webp", 5242880, 8192, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := copied.Writer.ExecContext(ctx, `UPDATE highlights SET style = 'bad'`); err == nil {
		t.Fatal("invalid highlight style accepted")
	}
	pageSQL := `INSERT INTO page_annotations
		(id, user_id, book_id, book_file_id, kind, locator, position, data, created_at, updated_at, rev)
		VALUES ('018f0f7e-7b00-7000-8000-000000000002', 1, 1, 1, ?, ?, ?, ?, 1, 1, 1)`
	for _, test := range []struct {
		kind, locator, data string
		position            float64
	}{
		{"bad", `{}`, `{}`, 0},
		{"text", `{`, `{}`, 0},
		{"text", `{}`, `{`, 0},
		{"text", `{}`, `{}`, 1.1},
	} {
		if _, err := copied.Writer.ExecContext(ctx, pageSQL, test.kind, test.locator, test.position, test.data); err == nil {
			t.Fatalf("invalid page annotation accepted: %+v", test)
		}
	}
	if _, err := copied.Writer.ExecContext(ctx, pageSQL, "text", `{}`, 0, `{}`); err != nil {
		t.Fatal(err)
	}
	if _, err := copied.Writer.ExecContext(ctx, `DELETE FROM book_files WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	var fileID sql.NullInt64
	if err := copied.Writer.QueryRowContext(ctx, `SELECT book_file_id FROM page_annotations`).Scan(&fileID); err != nil || fileID.Valid {
		t.Fatalf("book file deletion did not clear reference: %v, %v", fileID, err)
	}
	if _, err := copied.Writer.ExecContext(ctx, `DELETE FROM books WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := copied.Writer.QueryRowContext(ctx, `SELECT count(*) FROM page_annotations`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("book deletion did not cascade: count=%d, %v", count, err)
	}
	if _, err := copied.Writer.ExecContext(ctx, `DELETE FROM users WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if err := copied.Writer.QueryRowContext(ctx, `SELECT count(*) FROM annotation_assets`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("user deletion did not cascade: count=%d, %v", count, err)
	}
	if err := runner.DownTo(ctx, 7); err != nil {
		t.Fatal(err)
	}
	if _, err := copied.Writer.ExecContext(ctx, `SELECT style FROM highlights`); err == nil {
		t.Fatal("highlight style survived rollback")
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestPDFAnnotationsMigrationFresh(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	runner := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`SELECT style FROM highlights LIMIT 0`,
		`SELECT * FROM page_annotations LIMIT 0`,
		`SELECT * FROM annotation_assets LIMIT 0`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, query); err != nil {
			t.Fatalf("fresh schema %q: %v", query, err)
		}
	}
}
