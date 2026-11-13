package catalog

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSetDefaultFile(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	if _, err := fixture.db.Writer.Exec(`INSERT INTO book_files (id,book_id,sha256,format,size_bytes,original_filename,created_at)
		VALUES (301,101,?,'pdf',5,'edition.pdf',2)`, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	defaults := func(book Book) []int64 {
		var ids []int64
		for _, file := range book.Files {
			if file.IsDefault {
				ids = append(ids, file.ID)
			}
		}
		return ids
	}
	id := func(value int64) *int64 { return &value }

	for _, fileID := range []int64{301, 201} {
		book, err := fixture.service.SetDefaultFile(ctx, admin, 101, id(fileID))
		if err != nil {
			t.Fatal(err)
		}
		if got := defaults(book); len(got) != 1 || got[0] != fileID {
			t.Fatalf("default files = %v, want [%d]", got, fileID)
		}
	}
	for _, tc := range []struct {
		name    string
		viewer  Viewer
		fileID  *int64
		wantErr error
	}{
		{"other book's file", admin, id(202), ErrNotFound},
		{"reader", Viewer{UserID: 2}, id(301), ErrForbidden},
		{"invalid", admin, id(0), ErrInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := fixture.service.SetDefaultFile(ctx, tc.viewer, 101, tc.fileID); !errors.Is(err, tc.wantErr) {
				t.Fatalf("error=%v, want %v", err, tc.wantErr)
			}
			book, err := fixture.service.GetBook(ctx, admin, 101)
			if got := defaults(book); err != nil || len(got) != 1 || got[0] != 201 {
				t.Fatalf("rejected change altered default: %v, %v", got, err)
			}
		})
	}
	book, err := fixture.service.SetDefaultFile(ctx, admin, 101, nil)
	if err != nil || len(defaults(book)) != 0 {
		t.Fatalf("clear default: %v, %v", defaults(book), err)
	}
}
