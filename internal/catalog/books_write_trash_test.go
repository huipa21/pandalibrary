package catalog

import (
	"context"
	"errors"
	"testing"
)

func TestDeleteBookFileMovesFormatToTrash(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	fileID := fixture.files[101]
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
		VALUES (205, 101, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'pdf', 4, 'second.pdf', 1)`); err != nil {
		t.Fatal(err)
	}

	if err := fixture.service.DeleteBookFile(ctx, admin, 101, fileID); err != nil {
		t.Fatal(err)
	}
	book, err := fixture.service.GetBook(ctx, admin, 101)
	if err != nil {
		t.Fatal(err)
	}
	if len(book.Files) != 1 || book.Files[0].ID != 205 {
		t.Fatalf("remaining files = %+v, want only file 205", book.Files)
	}
	var deletedAt int64
	if err := fixture.db.Reader.QueryRowContext(ctx,
		`SELECT COALESCE(deleted_at, 0) FROM book_files WHERE id = ?`, fileID).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	if deletedAt == 0 {
		t.Fatal("file was not marked as deleted")
	}
	if err := fixture.service.DeleteBookFile(ctx, admin, 101, 205); !errors.Is(err, ErrConflict) {
		t.Fatalf("last file delete = %v, want ErrConflict", err)
	}
	if err := fixture.db.Reader.QueryRowContext(ctx, `SELECT COALESCE(deleted_at, 0) FROM book_files WHERE id = 205`).Scan(&deletedAt); err != nil || deletedAt != 0 {
		t.Fatalf("last file was removed: %d, %v", deletedAt, err)
	}
	if err := fixture.service.DeleteBookFile(ctx, admin, 101, fileID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v, want ErrNotFound", err)
	}
	if _, err := fixture.service.GetBook(ctx, admin, 101); err != nil {
		t.Fatalf("book disappeared with its file: %v", err)
	}
	if err := fixture.service.DeleteBookFile(ctx, Viewer{UserID: 2}, 101, 205); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-admin delete = %v, want ErrForbidden", err)
	}
}
