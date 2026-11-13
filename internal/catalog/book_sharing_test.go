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

func TestAdminClaimsOwnerlessBook(t *testing.T) {
	for _, visibility := range []string{"private", "public"} {
		t.Run(visibility, func(t *testing.T) {
			f := newCatalogFixture(t)
			ctx := context.Background()
			admin := Viewer{UserID: 1, IsAdmin: true}
			reader := Viewer{UserID: 2}

			legacy, err := f.service.GetBook(ctx, admin, 101)
			if err != nil || legacy.OwnerID != nil || legacy.Visibility != "library" || !legacy.CanManageVisibility {
				t.Fatalf("admin legacy=%+v err=%v", legacy, err)
			}
			readerBook, err := f.service.GetBook(ctx, reader, 101)
			if err != nil || readerBook.CanManageVisibility {
				t.Fatalf("reader legacy=%+v err=%v", readerBook, err)
			}
			if _, err := f.service.SetVisibility(ctx, reader, 101, visibility); !errors.Is(err, ErrForbidden) {
				t.Fatalf("reader claimed ownerless book: %v", err)
			}

			claimed, err := f.service.SetVisibility(ctx, admin, 101, visibility)
			if err != nil || claimed.OwnerID == nil || *claimed.OwnerID != admin.UserID ||
				claimed.Visibility != visibility || !claimed.CanManageVisibility {
				t.Fatalf("claimed=%+v err=%v", claimed, err)
			}
			_, err = f.service.GetBook(ctx, reader, 101)
			if visibility == "private" && !errors.Is(err, ErrNotFound) {
				t.Fatalf("reader saw private book: %v", err)
			}
			if visibility == "public" && err != nil {
				t.Fatalf("reader could not see public book: %v", err)
			}
			if _, err := f.service.SetVisibility(ctx, admin, 101, "public"); err != nil {
				t.Fatal(err)
			}
			if _, err := f.service.GetBook(ctx, reader, 101); err != nil {
				t.Fatalf("reader could not see republished book: %v", err)
			}
			otherAdmin := Viewer{UserID: 3, IsAdmin: true}
			otherBook, err := f.service.GetBook(ctx, otherAdmin, 101)
			if err != nil || otherBook.CanManageVisibility {
				t.Fatalf("other admin book=%+v err=%v", otherBook, err)
			}
			if _, err := f.service.SetVisibility(ctx, otherAdmin, 101, "private"); !errors.Is(err, ErrForbidden) {
				t.Fatalf("other admin changed claimed book: %v", err)
			}
		})
	}
}

func TestConcurrentAdminClaimsHaveOneOwner(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, id := range []int64{1, 3} {
		go func() {
			<-start
			_, err := f.service.SetVisibility(ctx, Viewer{UserID: id, IsAdmin: true}, 101, "public")
			results <- err
		}()
	}
	close(start)
	first, second := <-results, <-results
	if !((first == nil && errors.Is(second, ErrForbidden)) || (second == nil && errors.Is(first, ErrForbidden))) {
		t.Fatalf("claims returned %v and %v", first, second)
	}
	book, err := f.service.GetBook(ctx, Viewer{UserID: 2}, 101)
	if err != nil || book.OwnerID == nil || (*book.OwnerID != 1 && *book.OwnerID != 3) || book.Visibility != "public" {
		t.Fatalf("claimed book=%+v err=%v", book, err)
	}
}
