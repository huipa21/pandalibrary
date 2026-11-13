package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestFileBaseName(t *testing.T) {
	for _, test := range []struct{ stored, title, format, want string }{
		{"book.epub", "T", "epub", "book.epub"},
		{"dir/sub/book.epub", "T", "epub", "book.epub"},
		{`C:\Users\me\Books\book.pdf`, "T", "pdf", "book.pdf"},
		{`..\evil` + "\r\n" + `Injected.epub`, "T", "epub", "evil__Injected.epub"},
		{"/absolute/path/x.cbz", "T", "cbz", "x.cbz"},
		{"", "My Book", "epub", "My Book.epub"},
		{"  ", "My Book", "epub", "My Book.epub"},
		{"dir/", "T", "epub", "dir"},
		{"/", "A/B", "epub", "A_B.epub"},
		{"..", "", "pdf", "book.pdf"},
	} {
		if got := fileBaseName(test.stored, test.title, test.format); got != test.want {
			t.Errorf("fileBaseName(%q, %q, %q) = %q, want %q", test.stored, test.title, test.format, got, test.want)
		}
	}
}

func TestBookFileNameAndAddedDate(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		UPDATE book_files SET original_filename = 'library/authors/Tie A.epub', created_at = 1700000000123 WHERE book_id = 101;
		UPDATE book_files SET original_filename = '' WHERE book_id = 104;`); err != nil {
		t.Fatal(err)
	}
	reader := Viewer{UserID: 2}
	wantAdded := time.UnixMilli(1700000000123).UTC()
	check := func(source string, book Book) {
		t.Helper()
		if len(book.Files) != 1 {
			t.Fatalf("%s book %d files = %+v", source, book.ID, book.Files)
		}
		file := book.Files[0]
		switch book.ID {
		case 101:
			if file.OriginalFilename != "Tie A.epub" || !file.CreatedAt.Equal(wantAdded) || file.CreatedAt.Location() != time.UTC {
				t.Errorf("%s book 101 file = %+v", source, file)
			}
		case 104:
			if file.OriginalFilename != "Tie B.epub" {
				t.Errorf("%s book 104 fallback name = %q", source, file.OriginalFilename)
			}
		}
	}
	page, err := fixture.service.ListBooks(ctx, reader, BookFilters{}, PageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, book := range page.Items {
		check("list", book)
	}
	book, err := fixture.service.GetBook(ctx, reader, 101)
	if err != nil {
		t.Fatal(err)
	}
	check("detail", book)
	encoded, err := json.Marshal(book.Files[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(encoded), `{"id":201,"format":"epub","size_bytes":8,"download_url":"/api/v1/books/101/files/201?v=`) ||
		!strings.HasSuffix(string(encoded), `","original_filename":"Tie A.epub","created_at":"2023-11-14T22:13:20.123Z","is_default":false}`) {
		t.Fatalf("file JSON = %s", encoded)
	}
}

func TestListBookShelves(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	reader, other, admin := Viewer{UserID: 2}, Viewer{UserID: 3}, Viewer{UserID: 1, IsAdmin: true}
	mine, err := fixture.service.CreateShelf(ctx, reader, ShelfInput{Kind: "private", Name: "zeta"})
	if err != nil {
		t.Fatal(err)
	}
	shared, err := fixture.service.CreateShelf(ctx, admin, ShelfInput{Kind: "shared", Name: "Beta"})
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := fixture.service.CreateShelf(ctx, other, ShelfInput{Kind: "private", Name: "Alpha"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.CreateShelf(ctx, reader, ShelfInput{
		Kind: "private", Mode: ShelfModeAutomatic, Name: "Auto",
		Rules: &RuleSet{Match: "all", Conditions: []RuleCondition{{Field: "author_id", Op: "eq", Value: json.RawMessage("1")}}},
	}); err != nil {
		t.Fatal(err)
	}
	favorites, err := fixture.service.ensureFavorites(ctx, reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at) VALUES
		(?, 101, 0, 2, 1), (?, 101, 0, 1, 1), (?, 102, 1, 1, 1), (?, 101, 0, 3, 1), (?, 101, 0, 2, 1)`,
		mine.ID, shared.ID, shared.ID, foreign.ID, favorites); err != nil {
		t.Fatal(err)
	}
	ids := func(shelves []Shelf) []int64 {
		result := []int64{}
		for _, shelf := range shelves {
			result = append(result, shelf.ID)
		}
		return result
	}
	shelves, err := fixture.service.ListBookShelves(ctx, reader, 101)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := ids(shelves), []int64{shared.ID, favorites, mine.ID}; !reflect.DeepEqual(got, want) {
		t.Fatalf("reader shelves = %v, want %v", got, want)
	}
	for _, shelf := range shelves {
		listed, err := fixture.service.GetShelf(ctx, reader, shelf.ID)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(shelf, listed) {
			t.Errorf("shelf %+v differs from GetShelf %+v", shelf, listed)
		}
	}
	if shelves[0].VisibleBookCount != 1 {
		t.Errorf("shared shelf count = %d, want hidden book excluded", shelves[0].VisibleBookCount)
	}
	shelves, err = fixture.service.ListBookShelves(ctx, admin, 101)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := ids(shelves), []int64{foreign.ID, shared.ID, mine.ID}; !reflect.DeepEqual(got, want) {
		t.Fatalf("admin shelves = %v, want %v", got, want)
	}
	shelves, err = fixture.service.ListBookShelves(ctx, reader, 104)
	if err != nil || shelves == nil || len(shelves) != 0 {
		t.Fatalf("unshelved book shelves = %#v, %v", shelves, err)
	}
	for _, test := range []struct {
		viewer Viewer
		bookID int64
	}{{reader, 102}, {reader, 103}, {other, 101}, {reader, 9999}} {
		if _, err := fixture.service.ListBookShelves(ctx, test.viewer, test.bookID); !errors.Is(err, ErrNotFound) {
			t.Errorf("viewer %d book %d error = %v, want not found", test.viewer.UserID, test.bookID, err)
		}
	}
	if _, err := fixture.service.ListBookShelves(ctx, reader, 0); !errors.Is(err, ErrInvalid) {
		t.Errorf("invalid ID error = %v", err)
	}
}
