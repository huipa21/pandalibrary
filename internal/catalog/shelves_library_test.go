package catalog

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestShelfLibraryScope(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}
	if _, err := f.db.Writer.ExecContext(ctx, `
		INSERT INTO library_access (library_id, user_id, granted_at) VALUES (20, 2, 1);
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(105, 20, 'Second', 'second', 1, 1);
		INSERT INTO books (id, library_id, title, sort_title, owner_id, visibility, created_at, updated_at) VALUES
			(106, 20, 'Private secret', 'private secret', 3, 'private', 1, 1);`); err != nil {
		t.Fatal(err)
	}
	manual := createTestShelf(t, f.service, reader, "private", "Across libraries")
	empty := createTestShelf(t, f.service, reader, "private", "Empty reusable shelf")
	automatic := createAutomaticShelf(t, f.service, reader, "All books",
		rules("all", condition("title", "contains", `"e"`)))
	favorites := favoritesID(t, f.service, reader)
	for _, id := range []int64{101, 103} {
		if err := f.service.PutShelfBook(ctx, reader, manual.ID, id, nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []int64{101, 103, 104, 105} {
		if err := f.service.PutShelfBook(ctx, reader, favorites, id, nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, shelfID := range []int64{manual.ID, favorites} {
		if _, err := f.db.Writer.ExecContext(ctx, `
			INSERT INTO shelf_books (shelf_id, book_id, position, added_at) VALUES
				(?, 102, 100, 1), (?, 106, 101, 1)`, shelfID, shelfID); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		libraryID int64
		manual    []int64
		automatic []int64
		favorites []int64
		unshelved []int64
	}{
		{10, []int64{101}, []int64{101, 104}, []int64{101, 104}, []int64{104}},
		{20, []int64{103}, []int64{105, 103}, []int64{103, 105}, []int64{105}},
		{30, []int64{}, []int64{}, []int64{}, []int64{}},
	} {
		libraryID := test.libraryID
		page, err := f.service.ListShelves(ctx, reader, PageOptions{}, libraryID)
		if err != nil || len(page.Items) != 4 {
			t.Fatalf("library %d shelves = %+v, %v", libraryID, page, err)
		}
		counts := map[int64]int{manual.ID: len(test.manual), automatic.ID: len(test.automatic), favorites: len(test.favorites), empty.ID: 0}
		for _, shelf := range page.Items {
			if shelf.VisibleBookCount != int64(counts[shelf.ID]) {
				t.Fatalf("library %d shelf %+v", libraryID, shelf)
			}
		}
		for _, shelf := range []struct {
			id   int64
			want []int64
		}{{manual.ID, test.manual}, {automatic.ID, test.automatic}, {favorites, test.favorites}, {empty.ID, []int64{}}} {
			meta, err := f.service.GetShelf(ctx, reader, shelf.id, libraryID)
			if err != nil || meta.VisibleBookCount != int64(len(shelf.want)) {
				t.Fatalf("scoped metadata = %+v, %v", meta, err)
			}
			options := PageOptions{Limit: 1}
			got := []int64{}
			for {
				page, err := f.service.ListShelfBooks(ctx, reader, shelf.id, options, libraryID)
				if err != nil {
					t.Fatal(err)
				}
				for _, book := range page.Items {
					got = append(got, book.ID)
				}
				if page.NextCursor == nil {
					break
				}
				options.Cursor = *page.NextCursor
			}
			if !reflect.DeepEqual(got, shelf.want) {
				t.Fatalf("library %d shelf %d books = %v, want %v", libraryID, shelf.id, got, shelf.want)
			}
		}
		for _, system := range []struct {
			key  string
			want []int64
		}{{SystemShelfFavorites, test.favorites}, {SystemShelfUnshelved, test.unshelved}} {
			meta, err := f.service.GetSystemShelf(ctx, reader, system.key, libraryID)
			if err != nil || meta.VisibleBookCount != int64(len(system.want)) {
				t.Fatalf("system metadata = %+v, %v", meta, err)
			}
			page, err := f.service.ListSystemShelfBooks(ctx, reader, system.key, PageOptions{}, libraryID)
			got := []int64{}
			for _, book := range page.Items {
				got = append(got, book.ID)
			}
			if err != nil || !reflect.DeepEqual(got, system.want) {
				t.Fatalf("system books = %v, %v; want %v", got, err, system.want)
			}
		}
	}
	for _, shelfID := range []int64{automatic.ID, favorites} {
		page, err := f.service.ListShelfBooks(ctx, reader, shelfID, PageOptions{Limit: 1}, 10)
		if err != nil || page.NextCursor == nil {
			t.Fatalf("first page = %+v, %v", page, err)
		}
		for _, scope := range [][]int64{nil, {20}} {
			_, err := f.service.ListShelfBooks(ctx, reader, shelfID, PageOptions{Cursor: *page.NextCursor}, scope...)
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("cross-library cursor = %v", err)
			}
		}
	}
	list, err := f.service.ListShelves(ctx, reader, PageOptions{Limit: 1}, 10)
	if err != nil || list.NextCursor == nil {
		t.Fatalf("first shelf page = %+v, %v", list, err)
	}
	if _, err := f.service.ListShelves(ctx, reader, PageOptions{Cursor: *list.NextCursor}, 20); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cross-library shelf cursor = %v", err)
	}
	// Unshelved cursors must also remain library-specific.
	if err := f.service.RemoveShelfBook(ctx, reader, manual.ID, 101); err != nil {
		t.Fatal(err)
	}
	unshelved, err := f.service.ListSystemShelfBooks(ctx, reader, SystemShelfUnshelved, PageOptions{Limit: 1}, 10)
	if err != nil || unshelved.NextCursor == nil {
		t.Fatalf("unshelved first page = %+v, %v", unshelved, err)
	}
	if _, err := f.service.ListSystemShelfBooks(ctx, reader, SystemShelfUnshelved, PageOptions{Cursor: *unshelved.NextCursor}, 20); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cross-library unshelved cursor = %v", err)
	}
}

func TestLibraryVisibleBookCounts(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	if _, err := f.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, owner_id, visibility, created_at, updated_at) VALUES
			(105, 10, 'Private other', 'private other', 3, 'private', 1, 1),
			(106, 10, 'Private own', 'private own', 2, 'private', 1, 1),
			(107, 10, 'Public', 'public', 3, 'public', 1, 1);`); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		viewer Viewer
		want   map[int64]int64
	}{
		{Viewer{UserID: 2}, map[int64]int64{10: 4, 30: 0}},
		{Viewer{UserID: 1, IsAdmin: true}, map[int64]int64{10: 4, 20: 0, 30: 0}},
		{Viewer{UserID: 3}, map[int64]int64{20: 1}},
	} {
		page, err := f.service.ListLibraries(ctx, test.viewer, PageOptions{})
		if err != nil || len(page.Items) != len(test.want) {
			t.Fatalf("libraries = %+v, %v", page, err)
		}
		for _, library := range page.Items {
			want := test.want[library.ID]
			if library.VisibleBookCount != want {
				t.Fatalf("library count = %+v, want %d", library, want)
			}
			single, err := f.service.GetLibrary(ctx, test.viewer, library.ID)
			if err != nil || single.VisibleBookCount != want {
				t.Fatalf("get library = %+v, %v; want %d", single, err, want)
			}
		}
	}
}
