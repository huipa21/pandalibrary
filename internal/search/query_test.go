package search

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

type searchFixture struct {
	db      *db.DB
	service *Service
}

func newSearchFixture(t *testing.T) searchFixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "search.db")
	databases, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close databases: %v", err)
		}
	})
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), migrations.Options{AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1), (2, 'reader', 'x', 'user', 1, 1),
			(3, 'other', 'x', 'user', 1, 1), (4, 'ungranted', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1), (20, 3, 1)`,
		`INSERT INTO authors (id, name, sort_name, created_at) VALUES
			(1, '刘慈欣', '刘慈欣', 1), (2, '李雷', '李雷', 1), (3, 'unicorn writer', 'unicorn writer', 1)`,
		`INSERT INTO series (id, name, created_at) VALUES (1, 'unicorn series', 1)`,
		`INSERT INTO tags (id, name, created_at) VALUES (1, 'unicorn tag', 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, series_id, series_index, publisher, description, cover_sha256, created_at, updated_at) VALUES
			(101, 10, '三体Ⅱ：黑暗森林', '101', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(102, 10, '三体 黑暗森林 隐藏', '102', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(103, 20, '三体 黑暗森林 私密', '103', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(104, 10, 'Café', '104', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(105, 10, 'Alpha match', '105', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(106, 10, 'Unrelated', '106', NULL, NULL, NULL, 'alpha', NULL, 1, 1),
			(107, 10, 'Alpha match', '107', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(108, 10, 'Quotes "double" 100% a_b c\d %_', '108', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(109, 10, 'Distant forest', '109', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(110, 10, 'Title entry', '110', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(111, 10, 'Series entry', '111', 1, 1.5, NULL, NULL, NULL, 1, 1),
			(112, 10, 'Tag entry', '112', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(113, 10, 'Publishing entry', '113', NULL, NULL, 'unicorn press', NULL, NULL, 1, 1),
			(114, 10, 'Identifier entry', '114', NULL, NULL, NULL, NULL, NULL, 1, 1),
			(115, 10, 'Description entry', '115', NULL, NULL, NULL, 'unicorn paragraph', NULL, 1, 1)`,
		`INSERT INTO book_authors (book_id, author_id, role, position) VALUES
			(101, 1, 'author', 0), (102, 1, 'author', 0), (103, 1, 'author', 0),
			(104, 2, 'author', 0), (109, 2, 'author', 0), (110, 3, 'author', 0),
			(110, 2, 'translator', 1)`,
		`INSERT INTO book_tags (book_id, tag_id) VALUES (112, 1)`,
		`INSERT INTO book_identifiers (book_id, scheme, value) VALUES (114, 'doi', 'unicorn-123')`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 102, 1, 1), (1, 103, 1, 1)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed search fixture: %v", err)
		}
	}
	cover := strings.Repeat("a", 64)
	if _, err := databases.Writer.ExecContext(ctx, `UPDATE books SET cover_sha256 = ? WHERE id = 111`, cover); err != nil {
		t.Fatal(err)
	}
	if err := db.WithTx(ctx, databases.Writer, func(tx *sql.Tx) error {
		for id := int64(101); id <= 115; id++ {
			if err := IndexBook(ctx, tx, id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(databases.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return searchFixture{db: databases, service: service}
}

func resultIDs(page Page) []int64 {
	ids := make([]int64, 0, len(page.Items))
	for _, item := range page.Items {
		ids = append(ids, item.ID)
	}
	return ids
}

func TestSearchMatchingAndEscaping(t *testing.T) {
	fixture := newSearchFixture(t)
	viewer := Viewer{UserID: 2}
	for _, test := range []struct {
		name  string
		query string
		want  []int64
	}{
		{"CJK trigram", "黑暗森", []int64{101}},
		{"CJK short title", "三体", []int64{101}},
		{"short author", "李雷", []int64{104, 109, 110}},
		{"accent insensitive", "cafe", []int64{104}},
		{"NFKC", "Ｃａｆｅ", []int64{104}},
		{"short percent", "%", []int64{108}},
		{"short underscore", "_", []int64{108}},
		{"short backslash", `\`, []int64{108}},
		{"short quote", `"`, []int64{108}},
		{"literal percent and underscore", "%_", []int64{108}},
		{"quoted trigram", `"double"`, []int64{108}},
		{"backslash trigram", `c\d`, []int64{108}},
		{"mixed fields", "forest 李", []int64{109}},
		{"long terms AND", "distant forest", []int64{109}},
		{"unmatched short term", "forest 刘", []int64{}},
		{"unmatched long term", "distant missing", []int64{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			page, err := fixture.service.Search(context.Background(), viewer, test.query, PageOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if got := resultIDs(page); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("search %q = %v, want %v", test.query, got, test.want)
			}
			if page.NextCursor != nil {
				t.Fatalf("unexpected next cursor for %q", test.query)
			}
		})
	}
}

func TestSearchIndexedColumnsAndResultDTO(t *testing.T) {
	fixture := newSearchFixture(t)
	page, err := fixture.service.Search(context.Background(), Viewer{UserID: 2}, "unicorn", PageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	byID := make(map[int64]Result)
	for _, item := range page.Items {
		byID[item.ID] = item
	}
	for _, id := range []int64{110, 111, 112, 113, 114, 115} {
		if _, ok := byID[id]; !ok {
			t.Errorf("indexed metadata did not match book %d: %+v", id, page.Items)
		}
	}
	if len(byID) != 6 {
		t.Fatalf("unexpected indexed metadata results: %+v", page.Items)
	}
	if got := byID[110].Authors; !reflect.DeepEqual(got, []string{"unicorn writer", "李雷"}) {
		t.Errorf("authors are not in catalog order: %v", got)
	}
	series := byID[111].Series
	if series == nil || series.ID != 1 || series.Name != "unicorn series" ||
		series.Index == nil || *series.Index != 1.5 {
		t.Errorf("series DTO = %+v", series)
	}
	if byID[111].CoverURL == nil || *byID[111].CoverURL != "/api/v1/books/111/cover" {
		t.Errorf("cover URL = %v", byID[111].CoverURL)
	}
	if byID[115].Authors == nil || len(byID[115].Authors) != 0 {
		t.Errorf("empty authors must be an array: %+v", byID[115])
	}
}

func TestSearchTreatsFTSOperatorsAsLiteralText(t *testing.T) {
	fixture := newSearchFixture(t)
	for _, query := range []string{
		`"""`, `""a`, `a""`, `"a"`, `***`, `---`, `...`, `\\\`,
		`a\b`, `100%`, `ab_cd`, `*AND`, `"AND"`, `foo:bar`, `(alpha)`,
	} {
		if _, err := fixture.service.Search(context.Background(), Viewer{UserID: 2}, query, PageOptions{}); err != nil {
			t.Errorf("literal query %q failed: %v", query, err)
		}
	}
}

func TestSearchRankAndCursorPagination(t *testing.T) {
	fixture := newSearchFixture(t)
	viewer := Viewer{UserID: 2}
	full, err := fixture.service.Search(context.Background(), viewer, "Alpha", PageOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := resultIDs(full), []int64{105, 107, 106}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ranked IDs = %v, want %v", got, want)
	}
	if full.Items[0].Rank != full.Items[1].Rank || full.Items[1].Rank >= full.Items[2].Rank {
		t.Fatalf("title/description ranks = %+v", full.Items)
	}

	var paged []int64
	var token string
	for {
		page, err := fixture.service.Search(context.Background(), viewer, "Ａｌｐｈａ", PageOptions{Limit: 1, Cursor: token})
		if err != nil {
			t.Fatal(err)
		}
		paged = append(paged, resultIDs(page)...)
		if page.NextCursor == nil {
			break
		}
		token = *page.NextCursor
		if len(paged) > len(full.Items) {
			t.Fatal("cursor pagination repeated results")
		}
	}
	if !reflect.DeepEqual(paged, resultIDs(full)) {
		t.Fatalf("paged IDs = %v, want %v", paged, resultIDs(full))
	}
	first, err := fixture.service.Search(context.Background(), viewer, "Alpha", PageOptions{Limit: 1})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	for _, test := range []struct {
		viewer Viewer
		query  string
	}{
		{viewer, "different"},
		{Viewer{UserID: 3}, "Alpha"},
		{Viewer{UserID: 2, IsAdmin: true}, "Alpha"},
	} {
		_, err := fixture.service.Search(context.Background(), test.viewer, test.query,
			PageOptions{Limit: 1, Cursor: *first.NextCursor})
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("cross-query/viewer cursor error = %v", err)
		}
	}
	if _, err := fixture.service.Search(context.Background(), viewer, "Ａｌｐｈａ",
		PageOptions{Limit: 1, Cursor: *first.NextCursor}); err != nil {
		t.Fatalf("equivalent NFKC query rejected its cursor: %v", err)
	}
}

func TestSearchValidationAndDatabaseErrors(t *testing.T) {
	fixture := newSearchFixture(t)
	viewer := Viewer{UserID: 2}
	for _, query := range []string{
		"", " \t\n", "\x00", string([]byte{0xff}), strings.Repeat("a", maxQueryBytes+1),
		strings.Repeat("a ", maxQueryTerms+1),
	} {
		if _, err := fixture.service.Search(context.Background(), viewer, query, PageOptions{}); !errors.Is(err, ErrInvalid) {
			t.Errorf("invalid query %q: %v", query, err)
		}
	}
	for _, options := range []PageOptions{{Limit: -1}, {Limit: 101}, {Cursor: "not-base64!"}} {
		if _, err := fixture.service.Search(context.Background(), viewer, "alpha", options); !errors.Is(err, ErrInvalid) {
			t.Errorf("invalid options %+v: %v", options, err)
		}
	}
	missingRank := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(
		`{"v":1,"q":%q,"u":2,"a":false,"i":105}`, queryFingerprint("alpha"))))
	if _, err := fixture.service.Search(context.Background(), viewer, "alpha",
		PageOptions{Cursor: missingRank}); !errors.Is(err, ErrInvalid) {
		t.Errorf("cursor missing rank was accepted: %v", err)
	}
	if _, err := fixture.service.Search(context.Background(), Viewer{}, "alpha", PageOptions{}); !errors.Is(err, ErrInvalid) {
		t.Errorf("invalid viewer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fixture.service.Search(ctx, viewer, "alpha", PageOptions{}); !errors.Is(err, context.Canceled) {
		t.Errorf("canceled query error = %v", err)
	}
	if _, err := NewService(nil); err == nil {
		t.Error("nil reader was accepted")
	}
}

func TestSearchPageBounds(t *testing.T) {
	fixture := newSearchFixture(t)
	ctx := context.Background()
	if err := db.WithTx(ctx, fixture.db.Writer, func(tx *sql.Tx) error {
		for id := int64(200); id < 320; id++ {
			if _, err := tx.ExecContext(ctx, `INSERT INTO books
				(id, library_id, title, sort_title, created_at, updated_at)
				VALUES (?, 10, '书库 repeated phrase', 'repeated', 1, 1)`, id); err != nil {
				return err
			}
			if err := IndexBook(ctx, tx, id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	viewer := Viewer{UserID: 2}
	for _, test := range []struct {
		name   string
		query  string
		limit  int
		first  int
		second int
	}{
		{"default FTS", "repeated", 0, 50, 50},
		{"maximum FTS", "repeated", 100, 100, 20},
		{"maximum LIKE", "书库", 100, 100, 20},
	} {
		t.Run(test.name, func(t *testing.T) {
			first, err := fixture.service.Search(ctx, viewer, test.query, PageOptions{Limit: test.limit})
			if err != nil || len(first.Items) != test.first || first.NextCursor == nil {
				t.Fatalf("first page has %d items and cursor %v: %v", len(first.Items), first.NextCursor, err)
			}
			second, err := fixture.service.Search(ctx, viewer, test.query,
				PageOptions{Limit: test.limit, Cursor: *first.NextCursor})
			if err != nil || len(second.Items) != test.second {
				t.Fatalf("second page has %d items: %v", len(second.Items), err)
			}
			seen := make(map[int64]bool)
			for _, item := range append(first.Items, second.Items...) {
				if seen[item.ID] {
					t.Fatalf("book %d appeared on both pages", item.ID)
				}
				seen[item.ID] = true
			}
			if test.limit == 100 && second.NextCursor != nil {
				t.Fatal("last page has a continuation cursor")
			}
		})
	}
}
