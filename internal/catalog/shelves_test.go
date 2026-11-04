package catalog

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func createTestShelf(t *testing.T, service *Service, viewer Viewer, kind, name string) Shelf {
	t.Helper()
	shelf, err := service.CreateShelf(context.Background(), viewer, ShelfInput{Kind: kind, Name: name})
	if err != nil {
		t.Fatal(err)
	}
	return shelf
}

func shelfBookIDs(t *testing.T, service *Service, viewer Viewer, shelfID int64, limit int) []int64 {
	t.Helper()
	var result []int64
	options := PageOptions{Limit: limit}
	for pageNumber := 0; ; pageNumber++ {
		if pageNumber > 200 {
			t.Fatal("shelf book pagination did not terminate")
		}
		page, err := service.ListShelfBooks(context.Background(), viewer, shelfID, options)
		if err != nil {
			t.Fatal(err)
		}
		for _, book := range page.Items {
			result = append(result, book.ID)
		}
		if page.NextCursor == nil {
			return result
		}
		options.Cursor = *page.NextCursor
	}
}

func rawShelfOrder(t *testing.T, fixture catalogFixture, shelfID int64) ([]int64, []int64) {
	t.Helper()
	rows, err := fixture.db.Reader.QueryContext(context.Background(),
		`SELECT book_id, position FROM shelf_books WHERE shelf_id = ? ORDER BY position, book_id`, shelfID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids, positions []int64
	for rows.Next() {
		var id, position int64
		if err := rows.Scan(&id, &position); err != nil {
			t.Fatal(err)
		}
		ids, positions = append(ids, id), append(positions, position)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return ids, positions
}

func assertShelfOrder(t *testing.T, fixture catalogFixture, shelfID int64, want []int64) {
	t.Helper()
	ids, positions := rawShelfOrder(t, fixture, shelfID)
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("raw shelf order = %v, want %v", ids, want)
	}
	for index, position := range positions {
		if position != int64(index) {
			t.Fatalf("positions = %v, want contiguous positions", positions)
		}
	}
}

func TestShelfCRUDAndPermissions(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin, reader, other := Viewer{UserID: 1, IsAdmin: true}, Viewer{UserID: 2}, Viewer{UserID: 3}
	description := "reader's shelf"
	private, err := fixture.service.CreateShelf(ctx, reader, ShelfInput{
		Kind: "private", Name: "  Favorites  ", Description: &description,
	})
	if err != nil || private.Name != "Favorites" || private.OwnerID == nil || *private.OwnerID != 2 ||
		private.CreatedBy == nil || *private.CreatedBy != 2 || private.Description == nil ||
		*private.Description != description || private.VisibleBookCount != 0 {
		t.Fatalf("private shelf = %+v, %v", private, err)
	}
	shared := createTestShelf(t, fixture.service, admin, "shared", "Favorites")
	otherPrivate := createTestShelf(t, fixture.service, other, "private", "favorites")
	if shared.OwnerID != nil || shared.CreatedBy == nil || *shared.CreatedBy != 1 {
		t.Fatalf("shared shelf = %+v", shared)
	}
	for _, test := range []struct {
		name   string
		viewer Viewer
		input  ShelfInput
		want   error
	}{
		{"duplicate private", reader, ShelfInput{Kind: "private", Name: "FAVORITES"}, ErrConflict},
		{"duplicate shared", admin, ShelfInput{Kind: "shared", Name: "favorites"}, ErrConflict},
		{"reader shared", reader, ShelfInput{Kind: "shared", Name: "Public"}, ErrForbidden},
		{"invalid kind", reader, ShelfInput{Kind: "other", Name: "Name"}, ErrInvalid},
		{"empty name", reader, ShelfInput{Kind: "private", Name: "   "}, ErrInvalid},
		{"control in name", reader, ShelfInput{Kind: "private", Name: "bad\nname"}, ErrInvalid},
		{"long name", reader, ShelfInput{Kind: "private", Name: strings.Repeat("x", 1025)}, ErrInvalid},
		{"long description", reader, ShelfInput{Kind: "private", Name: "x", Description: ptrString(strings.Repeat("x", (1<<20)+1))}, ErrInvalid},
		{"NUL description", reader, ShelfInput{Kind: "private", Name: "x", Description: ptrString("x\x00y")}, ErrInvalid},
		{"invalid viewer", Viewer{}, ShelfInput{Kind: "private", Name: "x"}, ErrInvalid},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := fixture.service.CreateShelf(ctx, test.viewer, test.input); !errors.Is(err, test.want) {
				t.Fatalf("create error = %v, want %v", err, test.want)
			}
		})
	}
	for _, test := range []struct {
		viewer Viewer
		want   []int64
	}{
		{reader, []int64{private.ID, shared.ID}},
		{other, []int64{shared.ID, otherPrivate.ID}},
		{admin, []int64{private.ID, shared.ID, otherPrivate.ID}},
	} {
		page, err := fixture.service.ListShelves(ctx, test.viewer, PageOptions{})
		if err != nil {
			t.Fatal(err)
		}
		var ids []int64
		for i, shelf := range page.Items {
			if shelf.SystemKey != nil {
				// Only the viewer's own Favorites is listed, ahead of custom shelves.
				if i != 0 || *shelf.SystemKey != SystemShelfFavorites || shelf.OwnerID == nil || *shelf.OwnerID != test.viewer.UserID {
					t.Fatalf("viewer %d unexpected system shelf %+v at %d", test.viewer.UserID, shelf, i)
				}
				continue
			}
			ids = append(ids, shelf.ID)
		}
		if len(page.Items) == 0 || page.Items[0].SystemKey == nil || !reflect.DeepEqual(ids, test.want) || page.NextCursor != nil {
			t.Fatalf("viewer %d shelves = %v, want %v", test.viewer.UserID, ids, test.want)
		}
	}
	if _, err := fixture.service.GetShelf(ctx, other, private.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user's private shelf = %v", err)
	}
	if _, err := fixture.service.GetShelf(ctx, admin, private.ID); err != nil {
		t.Fatalf("admin cannot read private shelf: %v", err)
	}
	if _, err := fixture.service.UpdateShelf(ctx, reader, shared.ID, ShelfPatch{
		Name: Optional[string]{Set: true, Value: ptrString("Forbidden")},
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("reader updating shared shelf = %v", err)
	}
	if err := fixture.service.DeleteShelf(ctx, reader, otherPrivate.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reader deleting another private shelf = %v", err)
	}
	if err := fixture.service.DeleteShelf(ctx, reader, shared.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("reader deleting shared shelf = %v", err)
	}
	updated, err := fixture.service.UpdateShelf(ctx, reader, private.ID, ShelfPatch{
		Name: Optional[string]{Set: true, Value: ptrString(" Renamed ")}, Description: Optional[string]{Set: true},
	})
	if err != nil || updated.Name != "Renamed" || updated.Description != nil {
		t.Fatalf("update = %+v, %v", updated, err)
	}
	if _, err := fixture.service.UpdateShelf(ctx, reader, private.ID, ShelfPatch{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty patch = %v", err)
	}
	if _, err := fixture.service.UpdateShelf(ctx, reader, private.ID, ShelfPatch{
		Name: Optional[string]{Set: true},
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("null name = %v", err)
	}
	createTestShelf(t, fixture.service, reader, "private", "Taken")
	if _, err := fixture.service.UpdateShelf(ctx, reader, private.ID, ShelfPatch{
		Name: Optional[string]{Set: true, Value: ptrString("taken")},
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate update = %v", err)
	}
	if _, err := fixture.service.UpdateShelf(ctx, admin, otherPrivate.ID, ShelfPatch{
		Description: Optional[string]{Set: true, Value: ptrString("admin updated")},
	}); err != nil {
		t.Fatalf("admin update another private shelf: %v", err)
	}
	for _, test := range []struct {
		viewer Viewer
		id     int64
	}{
		{reader, private.ID}, {admin, otherPrivate.ID}, {admin, shared.ID},
	} {
		if err := fixture.service.DeleteShelf(ctx, test.viewer, test.id); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.service.GetShelf(ctx, admin, test.id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("deleted shelf = %v", err)
		}
	}
}

func ptrString(value string) *string { return &value }

func TestShelfTextValidationBoundaries(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}
	description := strings.Repeat("d", 1<<20)
	shelf, err := fixture.service.CreateShelf(ctx, reader, ShelfInput{
		Kind: "private", Name: strings.Repeat("n", 1024), Description: &description,
	})
	if err != nil || shelf.Description == nil || *shelf.Description != description {
		t.Fatalf("maximum length name/description rejected: %v", err)
	}
	invalidUTF8 := string([]byte{0xff})
	if _, err := fixture.service.CreateShelf(ctx, reader, ShelfInput{
		Kind: "private", Name: invalidUTF8,
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid UTF-8 name = %v", err)
	}
	if _, err := fixture.service.UpdateShelf(ctx, reader, shelf.ID, ShelfPatch{
		Description: Optional[string]{Set: true, Value: &invalidUTF8},
	}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid UTF-8 description = %v", err)
	}
}

func TestShelfVisibilityOrderingAndCounts(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin, reader, other := Viewer{UserID: 1, IsAdmin: true}, Viewer{UserID: 2}, Viewer{UserID: 3}
	shelf := createTestShelf(t, fixture.service, reader, "private", "Ordered")
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at) VALUES
		(?, 101, 0, 1, 1), (?, 102, 0, 1, 1), (?, 103, 0, 1, 1), (?, 104, 0, 1, 1)`,
		shelf.ID, shelf.ID, shelf.ID, shelf.ID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		viewer Viewer
		count  int64
		want   []int64
	}{
		{reader, 2, []int64{101, 104}},
		{admin, 3, []int64{101, 102, 104}},
	} {
		got, err := fixture.service.GetShelf(ctx, test.viewer, shelf.ID)
		if err != nil || got.VisibleBookCount != test.count {
			t.Fatalf("viewer %d count = %+v, %v", test.viewer.UserID, got, err)
		}
		page, err := fixture.service.ListShelves(ctx, test.viewer, PageOptions{})
		if err != nil || len(page.Items) != 2 || page.Items[0].SystemKey == nil || page.Items[1].ID != shelf.ID || page.Items[1].VisibleBookCount != test.count {
			t.Fatalf("viewer %d list count = %+v, %v", test.viewer.UserID, page, err)
		}
		if ids := shelfBookIDs(t, fixture.service, test.viewer, shelf.ID, 1); !reflect.DeepEqual(ids, test.want) {
			t.Fatalf("viewer %d books = %v, want %v", test.viewer.UserID, ids, test.want)
		}
	}
	first, err := fixture.service.ListShelfBooks(ctx, reader, shelf.ID, PageOptions{Limit: 1})
	if err != nil || first.NextCursor == nil || len(first.Items) != 1 {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	detail, err := fixture.service.GetBook(ctx, reader, 101)
	if err != nil || !reflect.DeepEqual(first.Items[0], detail) {
		t.Fatalf("shelf book was not hydrated like catalog detail: %+v, %+v, %v", first.Items[0], detail, err)
	}
	rawCursor, err := base64.RawURLEncoding.DecodeString(*first.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	var cursorFields map[string]any
	if err := json.Unmarshal(rawCursor, &cursorFields); err != nil {
		t.Fatal(err)
	}
	if _, leaksRawPosition := cursorFields["d"]; leaksRawPosition {
		t.Fatalf("cursor exposes a raw shelf position: %s", rawCursor)
	}
	if _, leaksRawCount := cursorFields["x"]; leaksRawCount {
		t.Fatalf("cursor exposes a raw shelf count: %s", rawCursor)
	}
	for _, test := range []struct {
		viewer Viewer
		bookID int64
	}{
		{reader, 102}, {reader, 103}, {reader, 9999}, {admin, 103},
	} {
		if err := fixture.service.PutShelfBook(ctx, test.viewer, shelf.ID, test.bookID, nil); !errors.Is(err, ErrNotFound) {
			t.Fatalf("add invisible book %d for %d = %v", test.bookID, test.viewer.UserID, err)
		}
		if err := fixture.service.RemoveShelfBook(ctx, test.viewer, shelf.ID, test.bookID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("remove invisible book %d for %d = %v", test.bookID, test.viewer.UserID, err)
		}
	}
	if err := fixture.service.PutShelfBook(ctx, other, shelf.ID, 103, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("add to inaccessible private shelf = %v", err)
	}
	zero := int64(0)
	if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, 104, &zero); err != nil {
		t.Fatal(err)
	}
	assertShelfOrder(t, fixture, shelf.ID, []int64{104, 101, 102, 103})
	if _, err := fixture.service.ListShelfBooks(ctx, reader, shelf.ID, PageOptions{Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cursor survived a reorder: %v", err)
	}
	for _, position := range []*int64{&zero, nil} {
		if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, 104, position); err != nil {
			t.Fatal(err)
		}
		assertShelfOrder(t, fixture, shelf.ID, []int64{104, 101, 102, 103})
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		VALUES (105, 10, 'New book', 'new book', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	one := int64(1)
	if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, 105, &one); err != nil {
		t.Fatal(err)
	}
	assertShelfOrder(t, fixture, shelf.ID, []int64{104, 105, 101, 102, 103})
	large := int64(1 << 60)
	if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, 104, &large); err != nil {
		t.Fatal(err)
	}
	assertShelfOrder(t, fixture, shelf.ID, []int64{105, 101, 102, 103, 104})
	negative := int64(-1)
	if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, 104, &negative); !errors.Is(err, ErrInvalid) {
		t.Fatalf("negative position = %v", err)
	}
	for range 2 {
		if err := fixture.service.RemoveShelfBook(ctx, reader, shelf.ID, 101); err != nil {
			t.Fatal(err)
		}
		assertShelfOrder(t, fixture, shelf.ID, []int64{105, 102, 103, 104})
	}
	first, err = fixture.service.ListShelfBooks(ctx, reader, shelf.ID, PageOptions{Limit: 1})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("page before visibility change = %+v, %v", first, err)
	}
	if err := fixture.service.SetHidden(ctx, admin, reader.UserID, 105, true); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.ListShelfBooks(ctx, reader, shelf.ID, PageOptions{Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cursor survived visibility change: %v", err)
	}
	if err := fixture.service.SetHidden(ctx, admin, reader.UserID, 102, false); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.SetAccess(ctx, admin, 20, reader.UserID, true); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.SetHidden(ctx, admin, reader.UserID, 105, false); err != nil {
		t.Fatal(err)
	}
	if ids := shelfBookIDs(t, fixture.service, reader, shelf.ID, 2); !reflect.DeepEqual(ids, []int64{105, 102, 103, 104}) {
		t.Fatalf("books after visibility changes = %v", ids)
	}
	if got, err := fixture.service.GetShelf(ctx, reader, shelf.ID); err != nil || got.VisibleBookCount != 4 {
		t.Fatalf("count after visibility changes = %+v, %v", got, err)
	}
	shared := createTestShelf(t, fixture.service, admin, "shared", "Shared")
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at)
		SELECT ?, book_id, position, added_by, added_at FROM shelf_books WHERE shelf_id = ?`, shared.ID, shelf.ID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		viewer Viewer
		want   int64
	}{
		{admin, 3}, {reader, 4}, {other, 1}, {Viewer{UserID: 4}, 0},
	} {
		got, err := fixture.service.GetShelf(ctx, test.viewer, shared.ID)
		if err != nil || got.VisibleBookCount != test.want {
			t.Fatalf("shared shelf viewer %d = %+v, %v, want %d", test.viewer.UserID, got, err, test.want)
		}
		jsonShelf, err := json.Marshal(got)
		if err != nil || strings.Contains(string(jsonShelf), `"book_count":`) ||
			!strings.Contains(string(jsonShelf), fmt.Sprintf(`"visible_book_count":%d`, test.want)) {
			t.Fatalf("shelf JSON exposes an unexpected count: %s, %v", jsonShelf, err)
		}
	}
}
