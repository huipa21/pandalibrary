package catalog

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"pandalibrary/internal/db"
)

func TestAssignableShelves(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin, reader := Viewer{UserID: 1, IsAdmin: true}, Viewer{UserID: 2}
	create := func(viewer Viewer, kind, name string) int64 {
		t.Helper()
		shelf, err := fixture.service.CreateShelf(ctx, viewer, ShelfInput{Kind: kind, Name: name})
		if err != nil {
			t.Fatalf("create shelf %q: %v", name, err)
		}
		return shelf.ID
	}
	shared := create(admin, "shared", "Shared")
	adminPrivate := create(admin, "private", "Admin private")
	readerPrivate := create(reader, "private", "Reader private")
	automatic := createAutomaticShelf(t, fixture.service, admin, "Auto", rules("all", condition("title", "contains", `"tie"`))).ID
	adminFavorites := favoritesID(t, fixture.service, admin)
	readerFavorites := favoritesID(t, fixture.service, reader)

	for _, test := range []struct {
		name   string
		viewer Viewer
		shelf  int64
		want   error
	}{
		{"admin shared", admin, shared, nil},
		{"admin own private", admin, adminPrivate, nil},
		{"admin favorites", admin, adminFavorites, nil},
		{"admin other private", admin, readerPrivate, ErrForbidden},
		{"admin other favorites", admin, readerFavorites, ErrNotFound},
		{"admin automatic", admin, automatic, ErrConflict},
		{"admin missing", admin, 99999, ErrNotFound},
		{"admin invalid", admin, 0, ErrInvalid},
		{"reader shared", reader, shared, ErrForbidden},
		{"reader own private", reader, readerPrivate, nil},
		{"reader favorites", reader, readerFavorites, nil},
		{"reader admin private", reader, adminPrivate, ErrNotFound},
	} {
		err := fixture.service.CheckAssignableShelf(ctx, test.viewer, test.shelf)
		if test.want == nil && err != nil || test.want != nil && !errors.Is(err, test.want) {
			t.Errorf("%s: CheckAssignableShelf = %v, want %v", test.name, err, test.want)
		}
	}

	add := func(viewer Viewer, shelfID, bookID int64) error {
		return db.WithTx(ctx, fixture.db.Writer, func(tx *sql.Tx) error {
			return AddAssignedBookTx(ctx, tx, viewer, shelfID, bookID, 1000)
		})
	}
	for _, bookID := range []int64{101, 104, 101} {
		if err := add(admin, shared, bookID); err != nil {
			t.Fatalf("add book %d: %v", bookID, err)
		}
	}
	page, err := fixture.service.ListShelfBooks(ctx, admin, shared, PageOptions{Limit: 10})
	if err != nil || len(page.Items) != 2 || page.Items[0].ID != 101 || page.Items[1].ID != 104 {
		t.Fatalf("shared shelf books = %+v, %v", page.Items, err)
	}
	if err := add(admin, readerPrivate, 101); !errors.Is(err, ErrForbidden) {
		t.Fatalf("add to another user's private shelf = %v", err)
	}
	if err := add(reader, shared, 101); !errors.Is(err, ErrForbidden) {
		t.Fatalf("reader add to shared shelf = %v", err)
	}
	if err := add(admin, automatic, 101); !errors.Is(err, ErrConflict) {
		t.Fatalf("add to automatic shelf = %v", err)
	}
	if err := add(reader, readerPrivate, 103); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reader add invisible book = %v", err)
	}
}
