package httpapi

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/trash"
)

func TestTrashHTTPBookLifecycleAndAuthorization(t *testing.T) {
	f := newCatalogHTTPFixture(t)
	ctx := context.Background()
	authn, err := auth.NewService(ctx, f.db.Writer, f.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	store, err := blobstore.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	books, err := catalog.NewService(f.db.Writer, f.db.Reader, store)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	f.router, err = NewRouter(RouterOptions{
		Database: f.db.Reader, Ready: func() bool { return true },
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("test")}},
		Logger: logger, MaxBodyBytes: 2 << 20,
		Mounts: []Mount{CatalogMount(books, authn, logger), TrashMount(trash.NewService(f.db.Writer), authn, logger)},
	})
	if err != nil {
		t.Fatal(err)
	}
	requireProblem(t, f.request(http.MethodGet, "/api/v1/trash", nil, nil, nil), http.StatusUnauthorized)
	requireProblem(t, f.request(http.MethodDelete, "/api/v1/books/101", nil, f.reader, nil), http.StatusForbidden)
	if res := f.request(http.MethodDelete, "/api/v1/books/101", nil, f.admin, nil); res.Code != http.StatusOK {
		t.Fatalf("delete book: %d %s", res.Code, res.Body.String())
	}
	requireProblem(t, f.request(http.MethodGet, "/api/v1/books/101", nil, f.reader, nil), http.StatusNotFound)
	res := f.request(http.MethodGet, "/api/v1/trash?type=book&search=Vis", nil, f.admin, nil)
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"id":"101"`) {
		t.Fatalf("list trash: %d %s", res.Code, res.Body.String())
	}
	res = f.request(http.MethodGet, "/api/v1/trash?type=book", nil, f.reader, nil)
	if res.Code != http.StatusOK || strings.Contains(res.Body.String(), `"id":"101"`) {
		t.Fatalf("reader trash: %d %s", res.Code, res.Body.String())
	}
	body := `{"items":[{"type":"book","id":"101"}]}`
	requireProblem(t, f.request(http.MethodPost, "/api/v1/trash/restore", strings.NewReader(body), f.reader, nil), http.StatusForbidden)
	if res = f.request(http.MethodPost, "/api/v1/trash/restore", strings.NewReader(body), f.admin, nil); res.Code != http.StatusNoContent {
		t.Fatalf("restore book: %d %s", res.Code, res.Body.String())
	}
	if res = f.request(http.MethodGet, "/api/v1/books/101", nil, f.reader, nil); res.Code != http.StatusOK {
		t.Fatalf("restored book: %d %s", res.Code, res.Body.String())
	}
	requireProblem(t, f.request(http.MethodDelete, "/api/v1/trash", strings.NewReader(body), f.admin, nil), http.StatusNotFound)
}
