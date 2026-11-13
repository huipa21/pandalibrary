package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"pandalibrary/internal/catalog"
)

func TestShelfHTTPLibraryScope(t *testing.T) {
	f := newShelfHTTPFixture(t)
	shelf := createHTTPShelf(t, f, f.reader, "private", "Reusable")
	expectShelfStatus(t, f.request(http.MethodPut, shelfHTTPBookPath(shelf.ID, 101), nil, f.reader, nil), http.StatusOK)
	response := f.request(http.MethodPost, "/api/v1/shelves",
		strings.NewReader(`{"kind":"private","mode":"automatic","name":"All","rules":{"match":"all","conditions":[{"field":"title","op":"contains","value":"i"}]}}`), f.reader, nil)
	expectShelfStatus(t, response, http.StatusCreated)
	automatic := decodeBody[map[string]catalog.Shelf](t, response.Result())["shelf"]
	paths := []string{
		"/api/v1/shelves",
		shelfHTTPPath(shelf.ID),
		shelfHTTPPath(shelf.ID) + "/books",
		shelfHTTPPath(automatic.ID),
		shelfHTTPPath(automatic.ID) + "/books",
		"/api/v1/shelves/system/favorites",
		"/api/v1/shelves/system/favorites/books",
		"/api/v1/shelves/system/unshelved",
		"/api/v1/shelves/system/unshelved/books",
	}

	for _, path := range paths {
		for _, query := range []string{"0", "-1", "abc", "9223372036854775808", "", "10&library_id=20"} {
			t.Run(path+"/invalid/"+query, func(t *testing.T) {
				expectShelfStatus(t, f.request(http.MethodGet, path+"?library_id="+query, nil, f.reader, nil), http.StatusBadRequest)
			})
		}
		for _, query := range []string{"20", "9999"} {
			t.Run(path+"/inaccessible/"+query, func(t *testing.T) {
				expectShelfStatus(t, f.request(http.MethodGet, path+"?library_id="+query, nil, f.reader, nil), http.StatusNotFound)
			})
		}
		expectShelfStatus(t, f.request(http.MethodGet, path+"?library_id=10", nil, f.reader, nil), http.StatusOK)
	}
	if _, err := f.db.Writer.Exec(`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (20, 2, 1), (30, 2, 1)`); err != nil {
		t.Fatal(err)
	}
	expectShelfStatus(t, f.request(http.MethodPut, shelfHTTPBookPath(shelf.ID, 103), nil, f.reader, nil), http.StatusOK)
	for _, test := range []struct {
		library string
		wantID  int64
	}{{"10", 101}, {"20", 103}} {
		response := f.request(http.MethodGet, shelfHTTPPath(shelf.ID)+"/books?library_id="+test.library, nil, f.reader, nil)
		expectShelfStatus(t, response, http.StatusOK)
		page := decodeBody[catalog.Page[catalog.Book]](t, response.Result())
		if len(page.Items) != 1 || page.Items[0].ID != test.wantID {
			t.Fatalf("scoped books = %+v", page)
		}
	}
	for _, path := range paths {
		response := f.request(http.MethodGet, path+"?library_id=30", nil, f.reader, nil)
		expectShelfStatus(t, response, http.StatusOK)
		if strings.HasSuffix(path, "/books") {
			page := decodeBody[catalog.Page[catalog.Book]](t, response.Result())
			if len(page.Items) != 0 {
				t.Fatalf("empty library books = %+v", page)
			}
		}
	}
	for _, path := range []string{"/api/v1/libraries", "/api/v1/libraries/10"} {
		response := f.request(http.MethodGet, path, nil, f.reader, nil)
		expectShelfStatus(t, response, http.StatusOK)
		if !strings.Contains(response.Body.String(), `"visible_book_count":1`) {
			t.Fatalf("library count contract missing: %s", response.Body.String())
		}
	}
}

func TestShelfHTTPFilteredBrowsing(t *testing.T) {
	f := newShelfHTTPFixture(t)
	shelf := createHTTPShelf(t, f, f.reader, "private", "Filtered")
	expectShelfStatus(t, f.request(http.MethodPut, shelfHTTPBookPath(shelf.ID, 101), nil, f.reader, nil), http.StatusOK)
	paths := []string{
		shelfHTTPPath(shelf.ID) + "/books",
		"/api/v1/shelves/system/favorites/books",
		"/api/v1/shelves/system/unshelved/books",
	}
	for _, path := range paths {
		for _, query := range []string{
			"author_id=0", "series_id=abc", "tag_id=-1", "sort=unknown",
			"sort=series", "sort=title&sort=added", "sort=title&library_id=9999",
		} {
			want := http.StatusBadRequest
			if strings.Contains(query, "library_id=9999") {
				want = http.StatusNotFound
			}
			t.Run(path+"/"+query, func(t *testing.T) {
				expectShelfStatus(t, f.request(http.MethodGet, path+"?"+query, nil, f.reader, nil), want)
			})
		}
		expectShelfStatus(t, f.request(http.MethodGet, path+"?sort=series&series_id=1&author_id=1&tag_id=1&library_id=10", nil, f.reader, nil), http.StatusOK)
	}
	response := f.request(http.MethodGet, shelfHTTPPath(shelf.ID)+"/books?sort=title&author_id=1", nil, f.reader, nil)
	expectShelfStatus(t, response, http.StatusOK)
	page := decodeBody[catalog.Page[catalog.Book]](t, response.Result())
	if len(page.Items) != 1 || page.Items[0].ID != 101 {
		t.Fatalf("filtered shelf books = %+v", page)
	}
}
