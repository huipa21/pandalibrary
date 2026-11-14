package stats

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestBooksExactCountsEditionsAndLocalMonth(t *testing.T) {
	f := newStatsFixture(t)
	f.exec(t, `UPDATE books SET created_at = ?, published_date = '2020-04-01', language = ' en ',
		page_count = 200 WHERE id = 101`, instant(t, "2026-02-01T00:30:00Z"))
	f.exec(t, `UPDATE books SET created_at = ?, published_date = '0000', language = '', page_count = 1001
		WHERE id = 104`, instant(t, "2026-02-01T08:00:00Z"))
	f.exec(t, `INSERT INTO tags (id, name, created_at) VALUES (1, 'Fiction', 1), (2, 'History', 1)`)
	f.exec(t, `INSERT INTO book_tags (book_id, tag_id) VALUES (101, 1), (104, 1), (101, 2)`)
	f.exec(t, `INSERT INTO book_authors (book_id, author_id, role, position) VALUES (104, 2, 'author', 0)`)
	// Two epub editions count as one format. The same bytes in a different
	// logical book count in that book too, as permitted by migration 12.
	for _, file := range []struct {
		id, book, sha, size int
		format              string
	}{{1, 101, 1, 100, "epub"}, {2, 101, 2, 200, "epub"}, {3, 101, 3, 300, "pdf"}, {4, 104, 1, 100, "epub"},
		{5, 102, 5, 9000, "cbz"}, {6, 103, 6, 8000, "mobi"}} {
		f.exec(t, `INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
			VALUES (?, ?, ?, ?, ?, 'book', 1)`, file.id, file.book, fmt.Sprintf("%064d", file.sha), file.format, file.size)
	}
	got, err := f.service.Books(context.Background(), Viewer{UserID: 2}, "America/Los_Angeles")
	if err != nil {
		t.Fatal(err)
	}
	want := BooksResponse{
		Timezone: "America/Los_Angeles", TotalBooks: 2,
		AddedOverTime:    []BookBucket{{"2026-01", 1}, {"2026-02", 1}},
		PublicationYears: []BookBucket{{"2020", 1}, {"unknown", 1}},
		Genres:           []BookBucket{{"Fiction", 2}, {"History", 1}},
		Languages:        []BookBucket{{"en", 1}, {"unknown", 1}},
		Formats:          []BookBucket{{"epub", 2}, {"pdf", 1}},
		PageCounts: []BookBucket{{"1-100", 0}, {"101-200", 1}, {"201-300", 0}, {"301-500", 0},
			{"501-1000", 0}, {"1001+", 1}, {"unknown", 0}},
		TopAuthors: []RankedAuthor{{"First", 2}, {"Later", 1}},
		LargestBooks: []RankedBook{{101, "Visible", []string{"First", "Later"}, 600},
			{104, "Second", []string{"First"}, 100}},
		MostPages: []RankedBook{{104, "Second", []string{"First"}, 1001},
			{101, "Visible", []string{"First", "Later"}, 200}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("books stats = %+v, want %+v", got, want)
	}
	utc, err := f.service.Books(context.Background(), Viewer{UserID: 2}, "UTC")
	if err != nil || !reflect.DeepEqual(utc.AddedOverTime, []BookBucket{{"2026-02", 2}}) {
		t.Fatalf("UTC months = %+v, %v", utc.AddedOverTime, err)
	}
}

func TestBooksVisibilityIncludesOwnersPublicAndHideList(t *testing.T) {
	f := newStatsFixture(t)
	f.exec(t, `INSERT INTO books (id, library_id, title, sort_title, owner_id, visibility, created_at, updated_at)
		VALUES (105, 20, 'Owned private', 'owned', 2, 'private', 1, 1),
		(106, 10, 'Other private', 'other', 3, 'private', 1, 1),
		(107, 20, 'Public', 'public', 3, 'public', 1, 1),
		(108, 20, 'Hidden public', 'hidden', 3, 'public', 1, 1),
		(109, 20, 'Owned library', 'owned', 2, 'library', 1, 1)`)
	f.exec(t, `INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at)
		VALUES (1, 108, 1, 1), (2, 108, 1, 1)`)
	f.exec(t, `INSERT INTO tags (id, name, created_at) VALUES (100, 'Secret', 1)`)
	f.exec(t, `INSERT INTO book_tags (book_id, tag_id) VALUES (106, 100), (108, 100), (102, 100)`)
	f.exec(t, `UPDATE books SET page_count = id`)
	for _, test := range []struct {
		viewer Viewer
		ids    []int64
	}{
		{Viewer{UserID: 2}, []int64{109, 107, 105, 104, 101}},
		{Viewer{UserID: 1, IsAdmin: true}, []int64{109, 107, 104, 103, 101}},
		{Viewer{UserID: 4}, []int64{108, 107}},
	} {
		got, err := f.service.Books(context.Background(), test.viewer, "UTC")
		if err != nil {
			t.Fatal(err)
		}
		ids := []int64{}
		for _, book := range got.MostPages {
			ids = append(ids, book.BookID)
		}
		if got.TotalBooks != int64(len(test.ids)) || !reflect.DeepEqual(ids, test.ids) {
			t.Fatalf("viewer %+v = %+v, want IDs %v", test.viewer, got, test.ids)
		}
		if test.viewer.UserID != 4 && len(got.Genres) != 0 {
			t.Fatalf("secret tags leaked: %+v", got.Genres)
		}
	}
}

func TestBooksTop20AndUnboundedAggregateInputs(t *testing.T) {
	f := newStatsFixture(t)
	f.exec(t, `WITH RECURSIVE n(x) AS (SELECT 200 UNION ALL SELECT x+1 FROM n WHERE x < 1224)
		INSERT INTO books (id, library_id, title, sort_title, page_count, created_at, updated_at)
		SELECT x, 10, 'Tie', 'tie', 100, 1, 1 FROM n`)
	f.exec(t, `INSERT INTO book_files (book_id, sha256, format, size_bytes, original_filename, created_at)
		SELECT id, printf('%064d', id), 'pdf', 100, 'book', 1 FROM books WHERE id >= 200`)
	for i := 0; i < 22; i++ {
		f.exec(t, `INSERT INTO authors (id, name, sort_name, created_at) VALUES (?, ?, ?, 1)`,
			100+i, fmt.Sprintf("A%02d", i), fmt.Sprintf("a%02d", i))
		f.exec(t, `INSERT INTO book_authors (book_id, author_id, role, position) VALUES (200, ?, 'author', ?)`, 100+i, i)
	}
	got, err := f.service.Books(context.Background(), Viewer{UserID: 2}, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if got.TotalBooks != 1027 || !reflect.DeepEqual(got.AddedOverTime, []BookBucket{{"1970-01", 1027}}) ||
		!reflect.DeepEqual(got.Formats, []BookBucket{{"pdf", 1025}}) || got.PageCounts[0].Count != 1025 ||
		got.PageCounts[6].Count != 2 {
		t.Fatalf("full aggregates = %+v", got)
	}
	if len(got.TopAuthors) != 20 || len(got.LargestBooks) != 20 || len(got.MostPages) != 20 {
		t.Fatalf("rank lengths = %d/%d/%d", len(got.TopAuthors), len(got.LargestBooks), len(got.MostPages))
	}
	for i := 0; i < 20; i++ {
		if got.TopAuthors[i] != (RankedAuthor{fmt.Sprintf("A%02d", i), 1}) ||
			got.LargestBooks[i].BookID != int64(200+i) || got.MostPages[i].BookID != int64(200+i) {
			t.Fatalf("rank %d = %+v / %+v / %+v", i, got.TopAuthors[i], got.LargestBooks[i], got.MostPages[i])
		}
	}
}

func TestBooksPageBoundariesEmptyAndValidation(t *testing.T) {
	f := newStatsFixture(t)
	f.exec(t, `UPDATE books SET visibility = 'private', owner_id = 3`)
	for i, pages := range []any{1, 100, 101, 200, 201, 300, 301, 500, 501, 1000, 1001, nil} {
		f.exec(t, `INSERT INTO books (id, library_id, title, sort_title, page_count, created_at, updated_at)
			VALUES (?, 10, 'Pages', 'pages', ?, 1, 1)`, 200+i, pages)
	}
	got, err := f.service.Books(context.Background(), Viewer{UserID: 2}, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	want := []BookBucket{{"1-100", 2}, {"101-200", 2}, {"201-300", 2}, {"301-500", 2},
		{"501-1000", 2}, {"1001+", 1}, {"unknown", 1}}
	if !reflect.DeepEqual(got.PageCounts, want) || len(got.MostPages) != 11 || len(got.LargestBooks) != 0 {
		t.Fatalf("page counts = %+v, ranks = %+v/%+v", got.PageCounts, got.MostPages, got.LargestBooks)
	}
	empty, err := f.service.Books(context.Background(), Viewer{UserID: 4}, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(empty)
	if err != nil || empty.TotalBooks != 0 || strings.Contains(string(data), "null") {
		t.Fatalf("empty response = %s, %v", data, err)
	}
	for _, zone := range []string{"", "Local", " UTC", "Unknown/Zone"} {
		if _, err := f.service.Books(context.Background(), Viewer{UserID: 2}, zone); !errors.Is(err, ErrInvalid) {
			t.Fatalf("zone %q error = %v", zone, err)
		}
	}
	if _, err := f.service.Books(context.Background(), Viewer{}, "UTC"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid viewer error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.service.Books(ctx, Viewer{UserID: 2}, "UTC"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled error = %v", err)
	}
}
