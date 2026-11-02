package catalog

import (
	"context"
	"encoding/base64"
	"errors"
	"reflect"
	"testing"
)

func TestBookPaginationWithTiesAndNullSeriesIndexes(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, series_id, series_index, created_at, updated_at)
		VALUES (105, 10, 'Tie C', 'tie', 1, 1, 100, 100),
		       (106, 10, 'Tie D', 'tie', 1, NULL, 100, 100)`); err != nil {
		t.Fatal(err)
	}
	admin := Viewer{UserID: 1, IsAdmin: true}
	for _, test := range []struct {
		name    string
		filters BookFilters
		want    []int64
	}{
		{"title", BookFilters{Sort: "title"}, []int64{102, 101, 104, 105, 106}},
		{"added", BookFilters{Sort: "added"}, []int64{106, 105, 104, 102, 101}},
		{"series", BookFilters{Sort: "series", SeriesID: 1}, []int64{101, 102, 105, 104, 106}},
	} {
		for _, limit := range []int{1, 2, 100} {
			t.Run(test.name, func(t *testing.T) {
				var got []int64
				cursor := ""
				for pageNumber := 0; ; pageNumber++ {
					if pageNumber > 10 {
						t.Fatal("pagination did not terminate")
					}
					page, err := fixture.service.ListBooks(ctx, admin, test.filters, PageOptions{Limit: limit, Cursor: cursor})
					if err != nil {
						t.Fatal(err)
					}
					for _, book := range page.Items {
						got = append(got, book.ID)
					}
					if page.NextCursor == nil {
						break
					}
					cursor = *page.NextCursor
				}
				if !reflect.DeepEqual(got, test.want) {
					t.Fatalf("limit %d IDs = %v, want %v", limit, got, test.want)
				}
			})
		}
	}
	first, err := fixture.service.ListBooks(ctx, admin, BookFilters{Sort: "title"}, PageOptions{Limit: 1})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	for _, test := range []struct {
		name    string
		viewer  Viewer
		filters BookFilters
		options PageOptions
	}{
		{"changed sort", admin, BookFilters{Sort: "added"}, PageOptions{Cursor: *first.NextCursor}},
		{"changed filter", admin, BookFilters{Sort: "title", LibraryID: 10}, PageOptions{Cursor: *first.NextCursor}},
		{"changed viewer", Viewer{UserID: 2}, BookFilters{Sort: "title"}, PageOptions{Cursor: *first.NextCursor}},
		{"malformed base64", admin, BookFilters{}, PageOptions{Cursor: "%%%"}},
		{"malformed JSON", admin, BookFilters{}, PageOptions{Cursor: base64.RawURLEncoding.EncodeToString([]byte("{"))}},
		{"extra JSON", admin, BookFilters{}, PageOptions{Cursor: base64.RawURLEncoding.EncodeToString([]byte(`{} {}`))}},
		{"unknown fields", admin, BookFilters{}, PageOptions{Cursor: base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"unknown":1}`))}},
		{"limit too large", admin, BookFilters{}, PageOptions{Limit: 101}},
		{"negative limit", admin, BookFilters{}, PageOptions{Limit: -1}},
		{"invalid filter", admin, BookFilters{TagID: -1}, PageOptions{}},
		{"invalid sort", admin, BookFilters{Sort: "other"}, PageOptions{}},
		{"series without filter", admin, BookFilters{Sort: "series"}, PageOptions{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := fixture.service.ListBooks(ctx, test.viewer, test.filters, test.options)
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("error = %v, want invalid", err)
			}
		})
	}
	if _, err := fixture.service.ListEntities(ctx, admin, "authors", PageOptions{Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cross-list cursor error = %v", err)
	}
}

func TestOtherCatalogListsUseKeysetPagination(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO authors (id, name, sort_name, created_at) VALUES
			(3, 'Another', 'Shared Author', 1), (4, 'Third', 'Shared Author', 1);
		INSERT INTO book_authors (book_id, author_id, role, position) VALUES
			(101, 3, 'editor', 2), (101, 4, 'editor', 3);
		INSERT INTO library_access (library_id, user_id, granted_at) VALUES
			(10, 3, 1), (10, 4, 1);
		INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES
			(2, 101, 1, 1), (2, 104, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	list := func(kind string, after string) ([]int64, *string, error) {
		options := PageOptions{Limit: 1, Cursor: after}
		switch kind {
		case "libraries":
			page, err := fixture.service.ListLibraries(ctx, admin, options)
			ids := make([]int64, 0, len(page.Items))
			for _, item := range page.Items {
				ids = append(ids, item.ID)
			}
			return ids, page.NextCursor, err
		case "authors", "series", "tags":
			page, err := fixture.service.ListEntities(ctx, admin, kind, options)
			ids := make([]int64, 0, len(page.Items))
			for _, item := range page.Items {
				ids = append(ids, item.ID)
			}
			return ids, page.NextCursor, err
		case "access":
			page, err := fixture.service.ListAccess(ctx, admin, 10, options)
			ids := make([]int64, 0, len(page.Items))
			for _, item := range page.Items {
				ids = append(ids, item.UserID)
			}
			return ids, page.NextCursor, err
		default:
			page, err := fixture.service.ListHidden(ctx, admin, 2, options)
			ids := make([]int64, 0, len(page.Items))
			for _, item := range page.Items {
				ids = append(ids, item.BookID)
			}
			return ids, page.NextCursor, err
		}
	}
	for _, test := range []struct {
		kind string
		want []int64
	}{
		{"libraries", []int64{30, 10, 20}},
		{"authors", []int64{1, 3, 4}},
		{"series", []int64{1}},
		{"tags", []int64{1}},
		{"access", []int64{2, 3, 4}},
		{"hidden", []int64{101, 102, 104}},
	} {
		t.Run(test.kind, func(t *testing.T) {
			var got []int64
			cursor := ""
			for n := 0; ; n++ {
				if n > 10 {
					t.Fatal("pagination did not terminate")
				}
				ids, next, err := list(test.kind, cursor)
				if err != nil {
					t.Fatal(err)
				}
				got = append(got, ids...)
				if next == nil {
					break
				}
				cursor = *next
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("IDs = %v, want %v", got, test.want)
			}
		})
	}
}
