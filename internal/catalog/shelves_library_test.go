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

func TestShelfFilteredBrowsing(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}
	if _, err := f.db.Writer.ExecContext(ctx, `
		INSERT INTO library_access (library_id, user_id, granted_at) VALUES (20, 2, 1);
		INSERT INTO books (id, library_id, title, sort_title, series_id, series_index, created_at, updated_at) VALUES
			(105, 10, 'Tie C', 'tie', 1, 1, 150, 150),
			(106, 10, 'Tie D', 'tie', 1, NULL, 150, 150),
			(107, 10, 'Tie E', 'tie', 1, 2, 200, 200),
			(108, 10, 'Tie F', 'tie', 1, NULL, 200, 200);
		INSERT INTO book_authors (book_id, author_id, role, position) VALUES
			(105, 1, 'author', 0), (106, 2, 'author', 0), (107, 1, 'author', 0), (108, 1, 'author', 0);
		INSERT INTO book_tags (book_id, tag_id) VALUES (105, 1), (106, 2), (107, 1), (108, 1);`); err != nil {
		t.Fatal(err)
	}
	manual := createTestShelf(t, f.service, reader, "private", "Browse")
	automatic := createAutomaticShelf(t, f.service, reader, "Rule browse",
		rules("all", condition("title", "contains", `"Tie"`)))
	favorites := favoritesID(t, f.service, reader)
	for _, shelfID := range []int64{manual.ID, favorites} {
		for _, id := range []int64{104, 101, 105, 106} {
			if err := f.service.PutShelfBook(ctx, reader, shelfID, id, nil); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO shelf_books (shelf_id, book_id, position, added_at) VALUES (?, 102, 99, 1)`, shelfID); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.service.PutShelfBook(ctx, reader, automatic.ID, 103, nil); err != nil {
		t.Fatal(err)
	}
	type listBooks func(BookFilters, PageOptions) (Page[Book], error)
	manualBooks := func(filters BookFilters, options PageOptions) (Page[Book], error) {
		return f.service.ListShelfBooksFiltered(ctx, reader, manual.ID, filters, options)
	}
	automaticBooks := func(filters BookFilters, options PageOptions) (Page[Book], error) {
		return f.service.ListShelfBooksFiltered(ctx, reader, automatic.ID, filters, options)
	}
	systemBooks := func(key string) listBooks {
		return func(filters BookFilters, options PageOptions) (Page[Book], error) {
			return f.service.ListSystemShelfBooksFiltered(ctx, reader, key, filters, options)
		}
	}
	for _, source := range []struct {
		name string
		list listBooks
	}{
		{"manual", manualBooks},
		{"favorites", systemBooks(SystemShelfFavorites)},
	} {
		for _, test := range []struct {
			name    string
			filters BookFilters
			want    []int64
		}{
			{"title", BookFilters{Sort: "title"}, []int64{101, 104, 105, 106}},
			{"added", BookFilters{Sort: "added"}, []int64{106, 105, 104, 101}},
			{"series", BookFilters{Sort: "series", SeriesID: 1}, []int64{101, 105, 104, 106}},
			{"combined filters", BookFilters{LibraryID: 10, AuthorID: 1, SeriesID: 1, TagID: 1}, []int64{101, 104, 105}},
			{"different tag", BookFilters{TagID: 2}, []int64{106}},
			{"different library", BookFilters{LibraryID: 20}, []int64{}},
		} {
			t.Run(source.name+"/"+test.name, func(t *testing.T) {
				got := []int64{}
				options := PageOptions{Limit: 1}
				for pageNumber := 0; ; pageNumber++ {
					if pageNumber > 10 {
						t.Fatal("pagination did not terminate")
					}
					page, err := source.list(test.filters, options)
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
				if !reflect.DeepEqual(got, test.want) {
					t.Fatalf("books = %v, want %v", got, test.want)
				}
			})
		}
	}
	for _, test := range []struct {
		name    string
		list    listBooks
		filters BookFilters
		want    []int64
	}{
		{"automatic union", automaticBooks, BookFilters{Sort: "title"}, []int64{103, 101, 104, 105, 106, 107, 108}},
		{"automatic filtered", automaticBooks, BookFilters{AuthorID: 2, TagID: 2, Sort: "added"}, []int64{106, 103}},
		{"unshelved series", systemBooks(SystemShelfUnshelved), BookFilters{SeriesID: 1, Sort: "series"}, []int64{107, 108}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := []int64{}
			options := PageOptions{Limit: 1}
			for {
				page, err := test.list(test.filters, options)
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
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("books = %v, want %v", got, test.want)
			}
		})
	}
	first, err := manualBooks(BookFilters{Sort: "title"}, PageOptions{Limit: 1})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	for name, list := range map[string]func() error{
		"sort": func() error {
			_, err := manualBooks(BookFilters{Sort: "added"}, PageOptions{Cursor: *first.NextCursor})
			return err
		},
		"filter": func() error {
			_, err := manualBooks(BookFilters{TagID: 1}, PageOptions{Cursor: *first.NextCursor})
			return err
		},
		"collection": func() error {
			_, err := automaticBooks(BookFilters{}, PageOptions{Cursor: *first.NextCursor})
			return err
		},
		"system endpoint": func() error {
			_, err := systemBooks(SystemShelfFavorites)(BookFilters{}, PageOptions{Cursor: *first.NextCursor})
			return err
		},
		"viewer": func() error {
			_, err := f.service.ListShelfBooksFiltered(ctx, Viewer{UserID: 1, IsAdmin: true}, manual.ID, BookFilters{}, PageOptions{Cursor: *first.NextCursor})
			return err
		},
		"invalid series sort": func() error {
			_, err := manualBooks(BookFilters{Sort: "series"}, PageOptions{})
			return err
		},
	} {
		if err := list(); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s error = %v, want invalid", name, err)
		}
	}
	if _, err := f.service.ListShelfBooksFiltered(ctx, Viewer{UserID: 3}, manual.ID, BookFilters{}, PageOptions{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user's private collection = %v", err)
	}
	favoritePage, err := systemBooks(SystemShelfFavorites)(BookFilters{}, PageOptions{Limit: 1})
	if err != nil || favoritePage.NextCursor == nil {
		t.Fatalf("favorites page = %+v, %v", favoritePage, err)
	}
	if _, err := f.service.ListShelfBooksFiltered(ctx, reader, favorites, BookFilters{}, PageOptions{Cursor: *favoritePage.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("system cursor on numeric shelf = %v", err)
	}
	if _, err := systemBooks(SystemShelfUnshelved)(BookFilters{}, PageOptions{Cursor: *favoritePage.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("favorites cursor on unshelved = %v", err)
	}
	if err := f.service.PutShelfBook(ctx, reader, favorites, 107, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := systemBooks(SystemShelfFavorites)(BookFilters{}, PageOptions{Cursor: *favoritePage.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("changed favorites cursor = %v", err)
	}
	if err := f.service.RemoveShelfBook(ctx, reader, manual.ID, 106); err != nil {
		t.Fatal(err)
	}
	if _, err := manualBooks(BookFilters{}, PageOptions{Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("changed membership cursor = %v", err)
	}
	rulePage, err := automaticBooks(BookFilters{}, PageOptions{Limit: 1})
	if err != nil || rulePage.NextCursor == nil {
		t.Fatalf("rule page = %+v, %v", rulePage, err)
	}
	if _, err := f.service.UpdateShelf(ctx, reader, automatic.ID, ShelfPatch{
		Rules: Optional[RuleSet]{Set: true, Value: rules("all", condition("title", "contains", `"changed"`))},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := automaticBooks(BookFilters{}, PageOptions{Cursor: *rulePage.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("changed rules cursor = %v", err)
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
