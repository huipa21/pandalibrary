package catalog

import (
	"context"
	"errors"
	"testing"

	"pandalibrary/internal/db/sqlc"
)

func TestBookSharingVisibilityRoots(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	if _, err := f.db.Writer.Exec(`UPDATE books SET owner_id = 2, visibility = 'private' WHERE id = 101;
		UPDATE books SET owner_id = 3, visibility = 'public' WHERE id IN (102,103)`); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		viewer  Viewer
		visible map[int64]bool
	}{
		{"owner", Viewer{UserID: 2}, map[int64]bool{101: true, 103: true, 104: true}},
		{"nonowner", Viewer{UserID: 4}, map[int64]bool{102: true, 103: true}},
		{"admin-nonowner", Viewer{UserID: 1, IsAdmin: true}, map[int64]bool{102: true, 104: true}},
	} {
		t.Run(test.name, func(t *testing.T) {
			queries := sqlc.New(f.db.Reader)
			for id := int64(101); id <= 104; id++ {
				for _, read := range bookVisibilityReads(ctx, queries, test.viewer, id, f.files[id]) {
					got, err := read.read()
					if err != nil || got != test.visible[id] {
						t.Errorf("%s book %d visible=%v err=%v", read.name, id, got, err)
					}
				}
			}
			page, err := f.service.ListBooks(ctx, test.viewer, BookFilters{}, PageOptions{})
			if err != nil || len(page.Items) != len(test.visible) {
				t.Fatalf("list=%v err=%v", page, err)
			}
			count, err := f.service.CountBooks(ctx, test.viewer)
			if err != nil || count != int64(len(test.visible)) {
				t.Fatalf("count=%d err=%v", count, err)
			}
		})
	}
	if _, err := f.service.GetBook(ctx, Viewer{}, 103); err == nil {
		t.Fatal("anonymous viewer read public book")
	}
}

func TestOwnerOnlySharingUpdates(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	legacy, err := f.service.GetBook(ctx, Viewer{UserID: 2}, 101)
	if err != nil || legacy.Visibility != "library" || legacy.OwnerID != nil || legacy.CanManageVisibility {
		t.Fatalf("legacy=%+v err=%v", legacy, err)
	}
	if _, err := f.db.Writer.Exec(`UPDATE books SET owner_id=2,visibility='public' WHERE id=101`); err != nil {
		t.Fatal(err)
	}
	for _, visibility := range []string{"", "library", "PUBLIC"} {
		if _, err := f.service.SetVisibility(ctx, Viewer{UserID: 2}, 101, visibility); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid visibility: %v", err)
		}
	}
	for _, viewer := range []Viewer{{UserID: 4}, {UserID: 1, IsAdmin: true}} {
		if _, err := f.service.SetVisibility(ctx, viewer, 101, "private"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("non-owner update: %v", err)
		}
	}
	book, err := f.service.SetVisibility(ctx, Viewer{UserID: 2}, 101, "private")
	if err != nil || book.Visibility != "private" || !book.CanManageVisibility || book.OwnerID == nil || *book.OwnerID != 2 {
		t.Fatalf("owner update=%+v err=%v", book, err)
	}
	if _, err := f.service.GetBook(ctx, Viewer{UserID: 1, IsAdmin: true}, 101); !errors.Is(err, ErrNotFound) {
		t.Fatalf("admin read private: %v", err)
	}
	if _, err := f.service.SetVisibility(ctx, Viewer{UserID: 2}, 101, "public"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.GetBook(ctx, Viewer{UserID: 4}, 101); err != nil {
		t.Fatal(err)
	}
}
