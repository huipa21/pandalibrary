package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"testing"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/db"
	"pandalibrary/internal/reading"
	"pandalibrary/internal/search"

	"github.com/go-chi/chi/v5"
)

type searchHTTPFixture struct {
	catalogHTTPFixture
	authentication *auth.Service
}

func newSearchHTTPFixture(t *testing.T) searchHTTPFixture {
	t.Helper()
	fixture := newCatalogHTTPFixture(t)
	ctx := context.Background()
	if err := db.WithTx(ctx, fixture.db.Writer, func(tx *sql.Tx) error {
		for _, update := range []struct {
			id    int64
			title string
		}{
			{101, `三体Ⅱ：黑暗森林 Café "quoted" 100% a_b c\d %_`},
			{102, "三体 黑暗森林 Hidden"},
			{103, "三体 黑暗森林 Secret"},
		} {
			if _, err := tx.ExecContext(ctx, `UPDATE books SET title = ? WHERE id = ?`, update.title, update.id); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO books
			(id, library_id, title, sort_title, description, created_at, updated_at) VALUES
			(104, 10, 'Alpha match', 'alpha', NULL, 1, 1),
			(105, 10, 'Other title', 'other', 'alpha', 1, 1)`); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO book_authors (book_id, author_id, role, position)
			VALUES (104, 1, 'author', 0), (105, 1, 'author', 0)`); err != nil {
			return err
		}
		for _, id := range []int64{101, 102, 103, 104, 105} {
			if err := search.IndexBook(ctx, tx, id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	authentication, err := auth.NewService(ctx, fixture.db.Writer, fixture.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	searchService, err := search.NewService(fixture.db.Reader)
	if err != nil {
		t.Fatal(err)
	}
	readingService, err := reading.NewService(fixture.db.Writer, fixture.db.Reader)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	protection, err := CookieProtection(nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	SearchMount(searchService, authentication, logger)(router, protection)
	ReadingMount(readingService, authentication, logger)(router, protection)
	fixture.router = router
	return searchHTTPFixture{catalogHTTPFixture: fixture, authentication: authentication}
}

func searchTarget(query string, options url.Values) string {
	values := url.Values{"q": {query}}
	for key, entries := range options {
		values[key] = entries
	}
	return "/api/v1/search?" + values.Encode()
}

func searchHTTPPage(t *testing.T, response *httptest.ResponseRecorder) search.Page {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("search status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("search cache policy = %q", response.Header().Get("Cache-Control"))
	}
	var page search.Page
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Items == nil {
		t.Fatal("search items must be a JSON array")
	}
	return page
}

func searchPageIDs(page search.Page) []int64 {
	ids := make([]int64, 0, len(page.Items))
	for _, item := range page.Items {
		ids = append(ids, item.ID)
	}
	return ids
}

func TestSearchHTTPMatchingAndVisibility(t *testing.T) {
	fixture := newSearchHTTPFixture(t)
	for _, test := range []struct {
		name  string
		query string
		want  []int64
	}{
		{"CJK trigram", "黑暗森", []int64{101}},
		{"CJK short", "三体", []int64{101}},
		{"short author", "Sh", []int64{101, 104, 105}},
		{"accent", "cafe", []int64{101}},
		{"percent", "%", []int64{101}},
		{"underscore", "_", []int64{101}},
		{"backslash", `\`, []int64{101}},
		{"quote", `"`, []int64{101}},
		{"percent underscore", "%_", []int64{101}},
		{"quoted phrase", `"quoted"`, []int64{101}},
		{"AND terms", "黑暗森 cafe", []int64{101}},
		{"AND excludes", "黑暗森 missing", []int64{}},
		{"FTS operators are literal", `" OR missing`, []int64{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := fixture.request(http.MethodGet, searchTarget(test.query, nil), nil, fixture.reader, nil)
			page := searchHTTPPage(t, response)
			if got := searchPageIDs(page); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("search %q = %v, want %v", test.query, got, test.want)
			}
		})
	}
	for _, test := range []struct {
		name   string
		cookie *http.Cookie
		want   []int64
	}{
		{"reader", fixture.reader, []int64{101}},
		{"admin cannot see hidden", fixture.admin, []int64{101, 102}},
		{"other library", fixture.other, []int64{103}},
	} {
		for _, query := range []string{"黑暗森", "三体"} {
			t.Run(test.name+"/"+query, func(t *testing.T) {
				page := searchHTTPPage(t, fixture.request(http.MethodGet, searchTarget(query, nil), nil, test.cookie, nil))
				got := searchPageIDs(page)
				sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
				if !reflect.DeepEqual(got, test.want) {
					t.Fatalf("visible IDs = %v, want %v", got, test.want)
				}
			})
		}
	}
	page := searchHTTPPage(t, fixture.request(http.MethodGet, searchTarget("cafe", nil), nil, fixture.reader, nil))
	item := page.Items[0]
	if item.ID != 101 || !reflect.DeepEqual(item.Authors, []string{"Shared Author"}) ||
		item.Series == nil || item.Series.Name != "Visible Series" || item.CoverURL == nil ||
		*item.CoverURL != "/api/v1/books/101/cover" {
		t.Fatalf("result DTO = %+v", item)
	}
	annotations := fixture.request(http.MethodGet, "/api/v1/search/annotations?q=test", nil, fixture.reader, nil)
	if annotations.Code != http.StatusOK || !strings.Contains(annotations.Body.String(), `"items":[]`) {
		t.Fatalf("annotation route was replaced: %d %s", annotations.Code, annotations.Body.String())
	}
	for _, kind := range []string{"review", "comment", "highlight", "underline", "strikeout", "text", "ink", "image"} {
		filtered := fixture.request(http.MethodGet, "/api/v1/search/annotations?q=test&kind="+kind, nil, fixture.reader, nil)
		if filtered.Code != http.StatusOK {
			t.Fatalf("annotation kind %s = %d %s", kind, filtered.Code, filtered.Body.String())
		}
	}
	for _, query := range []string{"q=test&kind=invalid", "q=test&kind=book_note", "q=test&kind=review&kind=comment"} {
		response := fixture.request(http.MethodGet, "/api/v1/search/annotations?"+query, nil, fixture.reader, nil)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid annotation filter = %d %s", response.Code, response.Body.String())
		}
	}
}

func TestSearchHTTPPaginationAndBadRequests(t *testing.T) {
	fixture := newSearchHTTPFixture(t)
	unauthenticated := fixture.request(http.MethodGet, searchTarget("alpha", nil), nil, nil, nil)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated search = %d", unauthenticated.Code)
	}
	first := searchHTTPPage(t, fixture.request(http.MethodGet,
		searchTarget("alpha", url.Values{"limit": {"1"}}), nil, fixture.reader, nil))
	if len(first.Items) != 1 || first.Items[0].ID != 104 || first.NextCursor == nil {
		t.Fatalf("first page = %+v", first)
	}
	next := url.Values{"limit": {"1"}, "cursor": {*first.NextCursor}}
	second := searchHTTPPage(t, fixture.request(http.MethodGet, searchTarget("alpha", next), nil, fixture.reader, nil))
	if len(second.Items) != 1 || second.Items[0].ID != 105 || second.NextCursor != nil ||
		first.Items[0].Rank >= second.Items[0].Rank {
		t.Fatalf("second page = %+v; first = %+v", second, first)
	}
	for _, response := range []*httptest.ResponseRecorder{
		fixture.request(http.MethodGet, searchTarget("different", next), nil, fixture.reader, nil),
		fixture.request(http.MethodGet, searchTarget("alpha", next), nil, fixture.admin, nil),
	} {
		if response.Code != http.StatusBadRequest {
			t.Errorf("mismatched cursor = %d %s", response.Code, response.Body.String())
		}
	}
	for _, rawQuery := range []string{
		"", "q=", "q=%20%20", "q=one&q=two", "q=alpha&unknown=x", "q=%ZZ", "q=%FF",
		"q=alpha&limit=0", "q=alpha&limit=101", "q=alpha&limit=-1", "q=alpha&limit=abc",
		"q=alpha&limit=1&limit=2", "q=alpha&cursor=", "q=alpha&cursor=not-valid!",
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/search", nil)
		request.URL.RawQuery = rawQuery
		request.RemoteAddr = "192.0.2.10:54321"
		request.AddCookie(fixture.reader)
		response := httptest.NewRecorder()
		fixture.router.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest ||
			!strings.Contains(response.Header().Get("Content-Type"), "application/problem+json") {
			t.Errorf("query %q = %d %s", rawQuery, response.Code, response.Body.String())
		}
	}
}

func TestSearchHTTPLogsDatabaseErrors(t *testing.T) {
	fixture := newSearchHTTPFixture(t)
	closed, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := closed.Close(); err != nil {
		t.Fatal(err)
	}
	service, err := search.NewService(closed)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	router := chi.NewRouter()
	SearchMount(service, fixture.authentication, logger)(router, nil)
	request := httptest.NewRequest(http.MethodGet, searchTarget("alpha", nil), nil)
	request.RemoteAddr = "192.0.2.10:54321"
	request.AddCookie(fixture.reader)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || !strings.Contains(logs.String(), "search request failed") {
		t.Fatalf("database error = %d %s, logs = %s", response.Code, response.Body.String(), logs.String())
	}
}
