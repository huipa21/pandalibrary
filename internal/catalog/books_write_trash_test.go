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

	if err := fixture.service.DeleteBookFile(ctx, admin, 101, fileID); err != nil {
		t.Fatal(err)
	}
	book, err := fixture.service.GetBook(ctx, admin, 101)
	if err != nil {
		t.Fatal(err)
	}
	if len(book.Files) != 0 {
		t.Fatalf("deleted format still visible: %+v", book.Files)
	}
	var deletedAt int64
	if err := fixture.db.Reader.QueryRowContext(ctx,
		`SELECT COALESCE(deleted_at, 0) FROM book_files WHERE id = ?`, fileID).Scan(&deletedAt); err != nil {
		t.Fatal(err)
	}
	if deletedAt == 0 {
		t.Fatal("format was not marked as deleted")
	}
	if err := fixture.service.DeleteBookFile(ctx, admin, 101, fileID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v, want ErrNotFound", err)
	}
	if _, err := fixture.service.GetBook(ctx, admin, 101); err != nil {
		t.Fatalf("book disappeared with its format: %v", err)
	}
	if err := fixture.service.DeleteBookFile(ctx, Viewer{UserID: 2}, 101, fileID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-admin delete = %v, want ErrForbidden", err)
	}
}
