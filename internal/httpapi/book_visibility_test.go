package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/catalog"
)

func TestBookVisibilityHTTP(t *testing.T) {
	f := newCatalogHTTPFixture(t)
	if _, err := f.db.Writer.Exec(`UPDATE books SET owner_id=2,visibility='public' WHERE id=101`); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		cookie *http.Cookie
		body   string
		want   int
	}{
		{"anonymous", nil, `{"visibility":"private"}`, 401},
		{"non-owner", f.other, `{"visibility":"private"}`, 403},
		{"admin-non-owner", f.admin, `{"visibility":"private"}`, 403},
		{"invalid", f.reader, `{"visibility":"library"}`, 400},
		{"missing", f.reader, `{}`, 400},
		{"null", f.reader, `{"visibility":null}`, 400},
		{"unknown-field", f.reader, `{"visibility":"private","owner_id":3}`, 400},
		{"owner", f.reader, `{"visibility":"private"}`, 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := f.request(http.MethodPut, "/api/v1/books/101/visibility", strings.NewReader(test.body), test.cookie, map[string]string{"Content-Type": "application/json"})
			if response.Code != test.want {
				t.Fatalf("%d: %s", response.Code, response.Body.String())
			}
			if response.Code == 200 {
				var body struct {
					Book catalog.Book `json:"book"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Book.Visibility != "private" || body.Book.OwnerID == nil || *body.Book.OwnerID != 2 || !body.Book.CanManageVisibility {
					t.Fatalf("body=%+v err=%v", body, err)
				}
			}
		})
	}
	for _, cookie := range []*http.Cookie{f.other, f.admin} {
		for _, suffix := range []string{"", "/cover", "/files/201"} {
			response := f.request(http.MethodGet, "/api/v1/books/101"+suffix, nil, cookie, nil)
			if response.Code != 404 {
				t.Fatalf("private %s: %d %s", suffix, response.Code, response.Body.String())
			}
		}
	}
}

func TestOwnerlessBookVisibilityHTTP(t *testing.T) {
	f := newCatalogHTTPFixture(t)
	for _, test := range []struct {
		name      string
		cookie    *http.Cookie
		canManage bool
	}{
		{"reader", f.reader, false},
		{"admin", f.admin, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := f.request(http.MethodGet, "/api/v1/books/101", nil, test.cookie, nil)
			var body struct {
				Book catalog.Book `json:"book"`
			}
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &body) != nil ||
				body.Book.OwnerID != nil || body.Book.Visibility != "library" || body.Book.CanManageVisibility != test.canManage {
				t.Fatalf("response=%d book=%+v", response.Code, body.Book)
			}
		})
	}
	change := func(cookie *http.Cookie, visibility string) int {
		response := f.request(http.MethodPut, "/api/v1/books/101/visibility",
			strings.NewReader(`{"visibility":"`+visibility+`"}`), cookie, map[string]string{"Content-Type": "application/json"})
		return response.Code
	}
	if code := change(f.reader, "private"); code != http.StatusForbidden {
		t.Fatalf("reader claimed ownerless book: %d", code)
	}
	if code := change(f.admin, "private"); code != http.StatusOK {
		t.Fatalf("admin could not claim book: %d", code)
	}
	for _, suffix := range []string{"", "/cover", "/files/201"} {
		if response := f.request(http.MethodGet, "/api/v1/books/101"+suffix, nil, f.reader, nil); response.Code != http.StatusNotFound {
			t.Fatalf("private %s: %d %s", suffix, response.Code, response.Body.String())
		}
	}
	if code := change(f.admin, "public"); code != http.StatusOK {
		t.Fatalf("admin could not republish book: %d", code)
	}
	if response := f.request(http.MethodGet, "/api/v1/books/101", nil, f.reader, nil); response.Code != http.StatusOK {
		t.Fatalf("republished book: %d %s", response.Code, response.Body.String())
	}
}

func TestUploadHTTPVisibilityPersistence(t *testing.T) {
	for _, visibility := range []string{"public", "private", ""} {
		t.Run("direct-"+visibility, func(t *testing.T) {
			f, service, _ := importFixture(t, 1<<20)
			parts := []uploadPart{{name: "library_id", data: "10"}, {name: "file", filename: "Visibility.fb2", data: `<FictionBook><description><title-info><book-title>Sharing</book-title></title-info></description></FictionBook>`}}
			if visibility != "" {
				parts = append(parts, uploadPart{name: "visibility", data: visibility})
			}

			body, kind := multipartBody(t, parts...)
			response := f.request(http.MethodPost, "/api/v1/uploads", bytes.NewReader(body), f.admin, map[string]string{"Content-Type": kind})
			if response.Code != 202 {
				t.Fatalf("upload=%d %s", response.Code, response.Body.String())
			}
			if err := service.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(5 * time.Second)
			for {
				var owner int64
				var got string
				err := f.db.Reader.QueryRow(`SELECT owner_id,visibility FROM books WHERE title='Sharing'`).Scan(&owner, &got)
				if err == nil {
					want := visibility
					if want == "" {
						want = "public"
					}
					if owner != 1 || got != want {
						t.Fatalf("owner=%d visibility=%s", owner, got)
					}
					break
				}
				if time.Now().After(deadline) {
					t.Fatal(err)
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
		t.Run("heap-"+visibility, func(t *testing.T) {
			f, _ := bookheapFixture(t, 1<<20)
			parts := []uploadPart{{name: "file", filename: "Visibility.epub", data: heapEPUB(t, visibility)}}
			if visibility != "" {
				parts = append(parts, uploadPart{name: "visibility", data: visibility})
			}
			response := f.heapUpload(t, parts...)
			defer response.Body.Close()
			if response.StatusCode != 201 {
				t.Fatalf("heap upload=%d", response.StatusCode)
			}
			var owner int64
			var got string
			if err := f.db.Reader.QueryRow(`SELECT added_by,visibility FROM bookheap_items`).Scan(&owner, &got); err != nil {
				t.Fatal(err)
			}
			want := visibility
			if want == "" {
				want = "public"
			}
			if owner != 1 || got != want {
				t.Fatalf("owner=%d visibility=%s", owner, got)
			}
		})
	}
	for _, endpoint := range []string{"direct", "heap"} {
		t.Run(endpoint+"-invalid", func(t *testing.T) {
			f, _, _ := importFixture(t, 1<<20)
			target := "/api/v1/uploads"
			parts := []uploadPart{{name: "library_id", data: "10"}, {name: "visibility", data: "library"}, {name: "file", filename: "bad.fb2", data: "x"}}
			if endpoint == "heap" {
				f, _ = bookheapFixture(t, 1<<20)
				target = "/api/v1/admin/bookheap/files"
				parts = parts[1:]
			}
			body, kind := multipartBody(t, parts...)
			response := f.request(http.MethodPost, target, bytes.NewReader(body), f.admin, map[string]string{"Content-Type": kind})
			if response.Code != 400 {
				t.Fatal(fmt.Sprintf("invalid upload=%d %s", response.Code, response.Body.String()))
			}
		})
	}
}
