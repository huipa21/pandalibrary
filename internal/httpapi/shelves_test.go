package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
)

func newShelfHTTPFixture(t *testing.T) catalogHTTPFixture {
	t.Helper()
	fixture := newCatalogHTTPFixture(t)
	store, err := blobstore.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service, err := catalog.NewService(fixture.db.Writer, fixture.db.Reader, store)
	if err != nil {
		t.Fatal(err)
	}
	authentication, err := auth.NewService(context.Background(), fixture.db.Writer, fixture.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router, err := NewRouter(RouterOptions{
		Database: fixture.db.Reader, Ready: func() bool { return true },
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>test</title>")}},
		Logger: logger, MaxBodyBytes: 32 << 20,
		Mounts: []Mount{CatalogMount(service, authentication, logger), ShelfMount(service, authentication, logger)},
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.router = router
	return fixture
}

func expectShelfStatus(t *testing.T, response *httptest.ResponseRecorder, status int) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d: %s", response.Code, status, response.Body.String())
	}
}

func createHTTPShelf(t *testing.T, fixture catalogHTTPFixture, cookie *http.Cookie, kind, name string) catalog.Shelf {
	t.Helper()
	body, err := json.Marshal(catalog.ShelfInput{Kind: kind, Name: name})
	if err != nil {
		t.Fatal(err)
	}
	response := fixture.request(http.MethodPost, "/api/v1/shelves", strings.NewReader(string(body)), cookie, nil)
	expectShelfStatus(t, response, http.StatusCreated)
	var result struct {
		Shelf catalog.Shelf `json:"shelf"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Shelf
}

func shelfHTTPPath(id int64) string {
	return fmt.Sprintf("/api/v1/shelves/%d", id)
}

func shelfHTTPBookPath(shelfID, bookID int64) string {
	return fmt.Sprintf("%s/books/%d", shelfHTTPPath(shelfID), bookID)
}

func TestShelfHTTPCRUDAndPermissions(t *testing.T) {
	fixture := newShelfHTTPFixture(t)
	expectShelfStatus(t, fixture.request(http.MethodGet, "/api/v1/shelves", nil, nil, nil), http.StatusUnauthorized)
	expectShelfStatus(t, fixture.request(http.MethodPost, "/api/v1/shelves",
		strings.NewReader(`{"kind":"shared","name":"Public"}`), fixture.reader, nil), http.StatusForbidden)
	private := createHTTPShelf(t, fixture, fixture.reader, "private", "Favorites")
	shared := createHTTPShelf(t, fixture, fixture.admin, "shared", "Favorites")
	other := createHTTPShelf(t, fixture, fixture.other, "private", "Favorites")
	if private.OwnerID == nil || *private.OwnerID != 2 || private.CreatedBy == nil || *private.CreatedBy != 2 ||
		shared.OwnerID != nil || shared.CreatedBy == nil || *shared.CreatedBy != 1 {
		t.Fatalf("unexpected owner/creator: private %+v, shared %+v", private, shared)
	}
	expectShelfStatus(t, fixture.request(http.MethodPost, "/api/v1/shelves",
		strings.NewReader(`{"kind":"private","name":"FAVORITES"}`), fixture.reader, nil), http.StatusConflict)
	expectShelfStatus(t, fixture.request(http.MethodPost, "/api/v1/shelves",
		strings.NewReader(`{"kind":"shared","name":"favorites"}`), fixture.admin, nil), http.StatusConflict)
	for _, test := range []struct {
		cookie *http.Cookie
		want   []int64
	}{
		{fixture.reader, []int64{private.ID, shared.ID}},
		{fixture.other, []int64{shared.ID, other.ID}},
		{fixture.admin, []int64{private.ID, shared.ID, other.ID}},
	} {
		response := fixture.request(http.MethodGet, "/api/v1/shelves?limit=100", nil, test.cookie, nil)
		expectShelfStatus(t, response, http.StatusOK)
		var page catalog.Page[catalog.Shelf]
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		var ids []int64
		for _, shelf := range page.Items {
			ids = append(ids, shelf.ID)
		}
		if !reflect.DeepEqual(ids, test.want) || page.NextCursor != nil {
			t.Fatalf("shelf list = %v, want %v", ids, test.want)
		}
	}
	expectShelfStatus(t, fixture.request(http.MethodGet, shelfHTTPPath(private.ID), nil, fixture.other, nil), http.StatusNotFound)
	expectShelfStatus(t, fixture.request(http.MethodGet, shelfHTTPPath(private.ID), nil, fixture.admin, nil), http.StatusOK)
	expectShelfStatus(t, fixture.request(http.MethodPatch, shelfHTTPPath(shared.ID),
		strings.NewReader(`{"name":"No"}`), fixture.reader, nil), http.StatusForbidden)
	expectShelfStatus(t, fixture.request(http.MethodPatch, shelfHTTPPath(other.ID),
		strings.NewReader(`{"name":"No"}`), fixture.reader, nil), http.StatusNotFound)
	expectShelfStatus(t, fixture.request(http.MethodDelete, shelfHTTPPath(shared.ID), nil, fixture.reader, nil), http.StatusForbidden)
	response := fixture.request(http.MethodPatch, shelfHTTPPath(private.ID),
		strings.NewReader(`{"name":"Renamed","description":"description"}`), fixture.reader, nil)
	expectShelfStatus(t, response, http.StatusOK)
	if !strings.Contains(response.Body.String(), `"name":"Renamed"`) ||
		!strings.Contains(response.Body.String(), `"description":"description"`) {
		t.Fatalf("update response = %s", response.Body.String())
	}
	response = fixture.request(http.MethodPatch, shelfHTTPPath(private.ID),
		strings.NewReader(`{"description":null}`), fixture.admin, nil)
	expectShelfStatus(t, response, http.StatusOK)
	if !strings.Contains(response.Body.String(), `"description":null`) {
		t.Fatalf("null description response = %s", response.Body.String())
	}
	expectShelfStatus(t, fixture.request(http.MethodDelete, shelfHTTPPath(private.ID), nil, fixture.reader, nil), http.StatusOK)
	expectShelfStatus(t, fixture.request(http.MethodGet, shelfHTTPPath(private.ID), nil, fixture.admin, nil), http.StatusNotFound)
	expectShelfStatus(t, fixture.request(http.MethodDelete, shelfHTTPPath(shared.ID), nil, fixture.admin, nil), http.StatusOK)
	expectShelfStatus(t, fixture.request(http.MethodDelete, shelfHTTPPath(other.ID), nil, fixture.admin, nil), http.StatusOK)
}

func TestShelfHTTPVisibilityCountsAndOrdering(t *testing.T) {
	fixture := newShelfHTTPFixture(t)
	private := createHTTPShelf(t, fixture, fixture.reader, "private", "Private")
	shared := createHTTPShelf(t, fixture, fixture.admin, "shared", "Shared")
	ctx := context.Background()
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		VALUES (104, 10, 'Another', 'another', 1, 1);
		INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at) VALUES
		(?, 101, 0, 1, 1), (?, 102, 0, 1, 1), (?, 103, 0, 1, 1), (?, 104, 0, 1, 1),
		(?, 101, 0, 1, 1), (?, 102, 1, 1, 1), (?, 103, 2, 1, 1)`,
		private.ID, private.ID, private.ID, private.ID, shared.ID, shared.ID, shared.ID); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		cookie *http.Cookie
		count  int64
		want   []int64
	}{
		{fixture.reader, 1, []int64{101}},
		{fixture.admin, 2, []int64{101, 102}},
		{fixture.other, 1, []int64{103}},
	} {
		response := fixture.request(http.MethodGet, shelfHTTPPath(shared.ID), nil, test.cookie, nil)
		expectShelfStatus(t, response, http.StatusOK)
		var metadata struct {
			Shelf map[string]any `json:"shelf"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &metadata); err != nil {
			t.Fatal(err)
		}
		if metadata.Shelf["visible_book_count"] != float64(test.count) {
			t.Fatalf("filtered shelf count = %v, want %d", metadata.Shelf, test.count)
		}
		if _, exists := metadata.Shelf["book_count"]; exists {
			t.Fatalf("raw book count leaked: %v", metadata.Shelf)
		}
		response = fixture.request(http.MethodGet, shelfHTTPPath(shared.ID)+"/books", nil, test.cookie, nil)
		expectShelfStatus(t, response, http.StatusOK)
		var page catalog.Page[catalog.Book]
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		var ids []int64
		for _, book := range page.Items {
			ids = append(ids, book.ID)
		}
		if !reflect.DeepEqual(ids, test.want) {
			t.Fatalf("shared book IDs = %v, want %v", ids, test.want)
		}
	}
	response := fixture.request(http.MethodGet, "/api/v1/shelves", nil, fixture.reader, nil)
	expectShelfStatus(t, response, http.StatusOK)
	var shelves catalog.Page[catalog.Shelf]
	if err := json.Unmarshal(response.Body.Bytes(), &shelves); err != nil {
		t.Fatal(err)
	}
	if len(shelves.Items) != 2 || shelves.Items[0].VisibleBookCount != 2 || shelves.Items[1].VisibleBookCount != 1 {
		t.Fatalf("list exposed incorrect visible counts: %+v", shelves.Items)
	}
	for _, id := range []int64{102, 103, 9999} {
		response = fixture.request(http.MethodPut, shelfHTTPBookPath(private.ID, id), nil, fixture.reader, nil)
		expectShelfStatus(t, response, http.StatusNotFound)
		if strings.Contains(response.Body.String(), "Hidden") || strings.Contains(response.Body.String(), "Secret") {
			t.Fatalf("book error leaked metadata: %s", response.Body.String())
		}
	}
	hidden := fixture.request(http.MethodPut, shelfHTTPBookPath(private.ID, 102), nil, fixture.reader, nil)
	missing := fixture.request(http.MethodPut, shelfHTTPBookPath(private.ID, 9999), nil, fixture.reader, nil)
	if hidden.Body.String() != missing.Body.String() {
		t.Fatalf("hidden and nonexistent book errors differ: %s / %s", hidden.Body, missing.Body)
	}
	expectShelfStatus(t, fixture.request(http.MethodPut, shelfHTTPBookPath(shared.ID, 103), nil, fixture.admin, nil), http.StatusNotFound)
	expectShelfStatus(t, fixture.request(http.MethodPut, shelfHTTPBookPath(shared.ID, 101), nil, fixture.reader, nil), http.StatusForbidden)
	expectShelfStatus(t, fixture.request(http.MethodPut, shelfHTTPBookPath(private.ID, 103), nil, fixture.other, nil), http.StatusNotFound)
	for range 2 {
		expectShelfStatus(t, fixture.request(http.MethodPut, shelfHTTPBookPath(private.ID, 104),
			strings.NewReader(`{"position":0}`), fixture.reader, nil), http.StatusOK)
	}
	response = fixture.request(http.MethodGet, shelfHTTPPath(private.ID)+"/books?limit=1", nil, fixture.reader, nil)
	expectShelfStatus(t, response, http.StatusOK)
	var first catalog.Page[catalog.Book]
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 1 || first.Items[0].ID != 104 || first.NextCursor == nil {
		t.Fatalf("first reordered page = %+v", first)
	}
	response = fixture.request(http.MethodGet, shelfHTTPPath(private.ID)+"/books?limit=1&cursor="+*first.NextCursor, nil, fixture.reader, nil)
	expectShelfStatus(t, response, http.StatusOK)
	var next catalog.Page[catalog.Book]
	if err := json.Unmarshal(response.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if len(next.Items) != 1 || next.Items[0].ID != 101 || next.NextCursor != nil {
		t.Fatalf("second reordered page = %+v", next)
	}
	for range 2 {
		expectShelfStatus(t, fixture.request(http.MethodDelete, shelfHTTPBookPath(private.ID, 101), nil, fixture.reader, nil), http.StatusOK)
	}
	expectShelfStatus(t, fixture.request(http.MethodDelete, shelfHTTPBookPath(private.ID, 102), nil, fixture.reader, nil), http.StatusNotFound)
	var remaining int
	if err := fixture.db.Reader.QueryRowContext(ctx, `SELECT count(*) FROM shelf_books WHERE shelf_id = ?`, private.ID).Scan(&remaining); err != nil || remaining != 3 {
		t.Fatalf("hidden members not retained: count %d, error %v", remaining, err)
	}
}

func TestShelfHTTPValidationAndCookieProtection(t *testing.T) {
	fixture := newShelfHTTPFixture(t)
	shelf := createHTTPShelf(t, fixture, fixture.admin, "shared", "Validation")
	base := shelfHTTPPath(shelf.ID)
	book := shelfHTTPBookPath(shelf.ID, 101)
	for _, target := range []string{
		"/api/v1/shelves?limit=0",
		"/api/v1/shelves?limit=101",
		"/api/v1/shelves?limit=1&limit=2",
		"/api/v1/shelves?cursor=",
		"/api/v1/shelves?limit=%",
		"/api/v1/shelves?sort=name",
		base + "/books?cursor=not-a-cursor",
		base + "/books?limit=-1",
		base + "?unknown=1",
	} {
		t.Run(target, func(t *testing.T) {
			expectShelfStatus(t, fixture.request(http.MethodGet, target, nil, fixture.admin, nil), http.StatusBadRequest)
		})
	}
	for _, body := range []string{
		`{"kind":"private","name":"x","owner_id":2}`,
		`{"kind":"private","name":"x","description":5}`,
		`{"kind":"private","name":null}`,
		`{"kind":"private","name":"x"} {}`,
	} {
		expectShelfStatus(t, fixture.request(http.MethodPost, "/api/v1/shelves",
			strings.NewReader(body), fixture.reader, nil), http.StatusBadRequest)
	}
	for _, body := range []string{
		`null`, `{"position":null}`, `{"position":-1}`, `{"position":"1"}`,
		`{"position":0,"unknown":true}`, `{"position":1} {}`, `{"position":`,
	} {
		expectShelfStatus(t, fixture.request(http.MethodPut, book, strings.NewReader(body), fixture.admin, nil), http.StatusBadRequest)
	}
	tooLarge := `{"position":` + strings.Repeat(" ", maxCatalogJSONBytes) + `1}`
	expectShelfStatus(t, fixture.request(http.MethodPut, book, strings.NewReader(tooLarge), fixture.admin, nil), http.StatusRequestEntityTooLarge)
	for _, body := range []io.Reader{nil, strings.NewReader(" \n"), strings.NewReader(`{}`)} {
		expectShelfStatus(t, fixture.request(http.MethodPut, book, body, fixture.admin, nil), http.StatusOK)
	}
	expectShelfStatus(t, fixture.request(http.MethodPut, book+"?unknown=1", nil, fixture.admin, nil), http.StatusBadRequest)
	expectShelfStatus(t, fixture.request(http.MethodPatch, base, strings.NewReader(`{"owner_id":2}`), fixture.admin, nil), http.StatusBadRequest)
	expectShelfStatus(t, fixture.request(http.MethodPatch, base, strings.NewReader(`{}`), fixture.admin, nil), http.StatusBadRequest)
	expectShelfStatus(t, fixture.request(http.MethodGet, "/api/v1/shelves/0", nil, fixture.admin, nil), http.StatusBadRequest)
	expectShelfStatus(t, fixture.request(http.MethodPut, base+"/books/not-a-number", nil, fixture.admin, nil), http.StatusBadRequest)
	for _, test := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/api/v1/shelves", `{"kind":"shared","name":"Cross site"}`},
		{http.MethodPatch, base, `{"name":"Cross site"}`},
		{http.MethodDelete, base, ""},
		{http.MethodPut, book, `{"position":0}`},
		{http.MethodDelete, book, ""},
	} {
		response := fixture.request(test.method, test.path, strings.NewReader(test.body), fixture.admin,
			map[string]string{"Sec-Fetch-Site": "cross-site"})
		expectShelfStatus(t, response, http.StatusForbidden)
	}
	response := fixture.request(http.MethodGet, base, nil, fixture.admin, nil)
	expectShelfStatus(t, response, http.StatusOK)
	if !strings.Contains(response.Body.String(), `"name":"Validation"`) ||
		!strings.Contains(response.Body.String(), `"visible_book_count":1`) {
		t.Fatalf("cross-origin requests changed the shelf: %s", response.Body.String())
	}
}

func TestShelfHTTPInternalErrorsAreNotExposed(t *testing.T) {
	fixture := newShelfHTTPFixture(t)
	shelf := createHTTPShelf(t, fixture, fixture.admin, "private", "Atomic")
	for _, id := range []int64{101, 102} {
		expectShelfStatus(t, fixture.request(http.MethodPut, shelfHTTPBookPath(shelf.ID, id), nil, fixture.admin, nil), http.StatusOK)
	}
	if _, err := fixture.db.Writer.ExecContext(context.Background(), `
		CREATE TRIGGER test_fail_http_shelf BEFORE UPDATE OF position ON shelf_books
		BEGIN SELECT RAISE(ABORT, 'sensitive internal failure'); END`); err != nil {
		t.Fatal(err)
	}
	response := fixture.request(http.MethodDelete, shelfHTTPBookPath(shelf.ID, 101), nil, fixture.admin, nil)
	expectShelfStatus(t, response, http.StatusInternalServerError)
	if strings.Contains(response.Body.String(), "sensitive") {
		t.Fatalf("internal database error exposed: %s", response.Body.String())
	}
	response = fixture.request(http.MethodGet, shelfHTTPPath(shelf.ID)+"/books", nil, fixture.admin, nil)
	expectShelfStatus(t, response, http.StatusOK)
	var page catalog.Page[catalog.Book]
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || len(page.Items) != 2 {
		t.Fatalf("failed deletion was not rolled back: %+v, %v", page, err)
	}
}
