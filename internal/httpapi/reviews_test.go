package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
)

func newReviewHTTPFixture(t *testing.T) catalogHTTPFixture {
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
	fixture.router, err = NewRouter(RouterOptions{
		Database: fixture.db.Reader, Ready: func() bool { return true },
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>test</title>")}},
		Logger: logger, MaxBodyBytes: 32 << 20,
		Mounts: []Mount{ReviewMount(service, authentication, logger)},
	})
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestReviewHTTPContract(t *testing.T) {
	f := newReviewHTTPFixture(t)
	const base = "/api/v1/books/101/reviews"
	empty := f.request(http.MethodGet, base, nil, f.reader, nil)
	expectShelfStatus(t, empty, http.StatusOK)
	if strings.TrimSpace(empty.Body.String()) != `{"mine":null,"items":[],"next_cursor":null,"total":0}` {
		t.Fatalf("empty shape: %s", empty.Body.String())
	}
	save := f.request(http.MethodPut, base+"/me", strings.NewReader(`{"body":"  A review  "}`), f.reader, nil)
	expectShelfStatus(t, save, http.StatusOK)
	var saved struct {
		Review catalog.Review `json:"review"`
	}
	if err := json.Unmarshal(save.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(save.Body.Bytes(), &envelope); err != nil || len(envelope) != 1 {
		t.Fatalf("save envelope: %v %v", envelope, err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(envelope["review"], &fields); err != nil || len(fields) != 7 {
		t.Fatalf("review shape: %v %v", fields, err)
	}
	for _, key := range []string{"id", "book_id", "author", "body", "created_at", "updated_at", "mine"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("missing field %s", key)
		}
	}
	for _, key := range []string{"created_at", "updated_at"} {
		var value string
		if err := json.Unmarshal(fields[key], &value); err != nil {
			t.Fatal(err)
		}
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
			t.Fatal(err)
		}
	}
	var author map[string]json.RawMessage
	if err := json.Unmarshal(fields["author"], &author); err != nil || len(author) != 2 || author["id"] == nil || author["display_name"] == nil {
		t.Fatalf("author shape: %v %v", author, err)
	}
	if !saved.Review.Mine || saved.Review.Body != "A review" || saved.Review.Author.DisplayName != "Reader" {
		t.Fatalf("review: %+v", saved.Review)
	}
	expectShelfStatus(t, f.request(http.MethodPut, base+"/me", strings.NewReader(`{"body":"edited"}`), f.reader, nil), http.StatusOK)
	expectShelfStatus(t, f.request(http.MethodPut, base+"/me", strings.NewReader(`{"body":"admin review"}`), f.admin, nil), http.StatusOK)
	list := f.request(http.MethodGet, base+"?limit=1", nil, f.reader, nil)
	expectShelfStatus(t, list, http.StatusOK)
	var page catalog.ReviewPage
	if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || page.Mine == nil || page.Mine.ID != saved.Review.ID || page.Mine.Body != "edited" ||
		len(page.Items) != 1 || page.Items[0].Mine || page.Items[0].Author.ID != 1 || page.NextCursor != nil {
		t.Fatalf("page: %+v", page)
	}
	byID := fmt.Sprintf("%s/%d", base, saved.Review.ID)
	expectShelfStatus(t, f.request(http.MethodDelete, byID, nil, f.reader, nil), http.StatusForbidden)
	expectShelfStatus(t, f.request(http.MethodDelete, fmt.Sprintf("/api/v1/books/102/reviews/%d", saved.Review.ID), nil, f.admin, nil), http.StatusNotFound)
	deleted := f.request(http.MethodDelete, byID, nil, f.admin, nil)
	expectShelfStatus(t, deleted, http.StatusNoContent)
	if deleted.Body.Len() != 0 {
		t.Fatal("204 response has a body")
	}
	expectShelfStatus(t, f.request(http.MethodDelete, base+"/me", nil, f.reader, nil), http.StatusNotFound)
	expectShelfStatus(t, f.request(http.MethodDelete, base+"/me", nil, f.admin, nil), http.StatusNoContent)
}

func TestReviewHTTPRejections(t *testing.T) {
	f := newReviewHTTPFixture(t)
	const base = "/api/v1/books/101/reviews"
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		path := base
		if method != http.MethodGet {
			path += "/me"
		}
		expectShelfStatus(t, f.request(method, path, strings.NewReader(`{"body":"review"}`), nil, nil), http.StatusUnauthorized)
	}
	for _, id := range []int{102, 103, 999} {
		path := fmt.Sprintf("/api/v1/books/%d/reviews", id)
		expectShelfStatus(t, f.request(http.MethodGet, path, nil, f.reader, nil), http.StatusNotFound)
		expectShelfStatus(t, f.request(http.MethodPut, path+"/me", strings.NewReader(`{"body":"review"}`), f.reader, nil), http.StatusNotFound)
		expectShelfStatus(t, f.request(http.MethodDelete, path+"/me", nil, f.reader, nil), http.StatusNotFound)
		expectShelfStatus(t, f.request(http.MethodDelete, path+"/1", nil, f.reader, nil), http.StatusNotFound)
	}
	for _, query := range []string{"?limit=0", "?limit=51", "?limit=1.5", "?limit=no", "?limit=1&limit=2", "?cursor=bad", "?cursor=", "?unknown=x"} {
		expectShelfStatus(t, f.request(http.MethodGet, base+query, nil, f.reader, nil), http.StatusBadRequest)
	}
	for _, body := range []string{`{}`, `null`, `{"body":null}`, `{"body":4}`, `{"body":" "}`, `{"body":"ok","unknown":true}`, `{"body":"ok"} {}`, `{"body":`} {
		expectShelfStatus(t, f.request(http.MethodPut, base+"/me", strings.NewReader(body), f.reader, nil), http.StatusBadRequest)
	}
	expectShelfStatus(t, f.request(http.MethodPut, base+"/me",
		strings.NewReader(`{"body":"`+strings.Repeat("x", 10001)+`"}`), f.reader, nil), http.StatusBadRequest)
	expectShelfStatus(t, f.request(http.MethodPut, base+"/me",
		strings.NewReader(`{"body":"`+strings.Repeat("x", maxCatalogJSONBytes)+`"}`), f.reader, nil), http.StatusRequestEntityTooLarge)
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		expectShelfStatus(t, f.request(method, base+"/me", strings.NewReader(`{"body":"review"}`), f.reader,
			map[string]string{"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}), http.StatusForbidden)
	}
	expectShelfStatus(t, f.request(http.MethodDelete, base+"/1", nil, f.admin,
		map[string]string{"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}), http.StatusForbidden)
	for _, path := range []string{"/api/v1/books/0/reviews", "/api/v1/books/no/reviews"} {
		expectShelfStatus(t, f.request(http.MethodGet, path, nil, f.reader, nil), http.StatusBadRequest)
	}
	for _, id := range []string{"0", "no"} {
		expectShelfStatus(t, f.request(http.MethodDelete, base+"/"+id, nil, f.admin, nil), http.StatusBadRequest)
	}
}
