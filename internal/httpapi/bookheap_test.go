package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"image/color"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/bookheap"
)

func bookheapFixture(t *testing.T, limit int64) (catalogHTTPFixture, string) {
	t.Helper()
	f := newCatalogHTTPFixture(t)
	root := t.TempDir()
	blobs, err := blobstore.New(root)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	heap := filepath.Join(root, "bookheap")
	service, err := bookheap.New(bookheap.Options{Writer: f.db.Writer, Reader: f.db.Reader, Blobs: blobs, Dir: heap, MaxBytes: limit, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := service.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	authentication, err := auth.NewService(context.Background(), f.db.Writer, f.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	f.router, err = NewRouter(RouterOptions{Database: f.db.Reader, Ready: func() bool { return true }, Logger: logger, MaxBodyBytes: limit + 64<<10,
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("test")}}, Mounts: []Mount{BookheapMount(service, authentication, logger)}})
	if err != nil {
		t.Fatal(err)
	}
	return f, heap
}

func heapEPUB(t *testing.T, extra string) string {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	add := func(name string, data []byte) {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	add("mimetype", []byte("application/epub+zip"))
	for _, item := range []struct{ source, target string }{{"container.xml", "META-INF/container.xml"}, {"package.opf", "OPS/package.opf"}} {
		data, err := os.ReadFile(filepath.Join("..", "extract", "testdata", "epub2", item.source))
		if err != nil {
			t.Fatal(err)
		}
		add(item.target, data)
	}
	add("OPS/cover.png", testPNG(t, color.RGBA{G: 200, A: 255}))
	add("OPS/extra.txt", []byte(extra))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.String()
}

func (f catalogHTTPFixture) heapUpload(t *testing.T, parts ...uploadPart) *http.Response {
	t.Helper()
	body, contentType := multipartBody(t, parts...)
	return f.request(http.MethodPost, "/api/v1/admin/bookheap/files", bytes.NewReader(body), f.admin, map[string]string{"Content-Type": contentType}).Result()
}

func decodeBody[T any](t *testing.T, response *http.Response) T {
	t.Helper()
	var value T
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestBookheapHTTPAuthorization(t *testing.T) {
	f, _ := bookheapFixture(t, 1<<20)
	body, contentType := multipartBody(t, uploadPart{name: "file", filename: "a.epub", data: heapEPUB(t, "a")})
	for _, test := range []struct {
		name, method, target string
		body                 []byte
		cookie               *http.Cookie
		headers              map[string]string
		want                 int
	}{
		{"list-unauthenticated", http.MethodGet, "/api/v1/admin/bookheap/items", nil, nil, nil, 401},
		{"list-reader", http.MethodGet, "/api/v1/admin/bookheap/items", nil, f.reader, nil, 403},
		{"scan-reader", http.MethodGet, "/api/v1/admin/bookheap/scan", nil, f.reader, nil, 403},
		{"upload-unauthenticated", http.MethodPost, "/api/v1/admin/bookheap/files", body, nil, map[string]string{"Content-Type": contentType}, 401},
		{"upload-reader", http.MethodPost, "/api/v1/admin/bookheap/files", body, f.reader, map[string]string{"Content-Type": contentType}, 403},
		{"upload-cross-site", http.MethodPost, "/api/v1/admin/bookheap/files", body, f.admin, map[string]string{"Content-Type": contentType, "Sec-Fetch-Site": "cross-site"}, 403},
		{"delete-cross-site", http.MethodPost, "/api/v1/admin/bookheap/items/delete", []byte(`{"ids":[1]}`), f.admin, map[string]string{"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"}, 403},
		{"scan-cross-site", http.MethodPost, "/api/v1/admin/bookheap/scan", nil, f.admin, map[string]string{"Sec-Fetch-Site": "cross-site"}, 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := f.request(test.method, test.target, bytes.NewReader(test.body), test.cookie, test.headers)
			if response.Code != test.want {
				t.Fatalf("response %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestBookheapHTTPUploadListCoverDelete(t *testing.T) {
	f, heap := bookheapFixture(t, 1<<20)
	response := f.heapUpload(t, uploadPart{name: "file", filename: "My Book.epub", data: heapEPUB(t, "a")})
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("upload %d", response.StatusCode)
	}
	created := decodeBody[map[string]map[string]any](t, response)["item"]
	if created["rel_path"] != "My Book.epub" || created["title"] != "The Fixture Book" || created["status"] != "ready" ||
		created["target_shelf_ids"] == nil || created["source"] != "upload" {
		t.Fatalf("item: %v", created)
	}

	duplicate := f.heapUpload(t, uploadPart{name: "file", filename: "again.epub", data: heapEPUB(t, "a")})
	problem := decodeBody[map[string]any](t, duplicate)
	if duplicate.StatusCode != http.StatusConflict || problem["duplicate_of_item_id"] != created["id"] || problem["status"] != float64(409) ||
		!strings.Contains(duplicate.Header.Get("Content-Type"), "application/problem+json") {
		t.Fatalf("duplicate %d %v", duplicate.StatusCode, problem)
	}
	library := f.heapUpload(t, uploadPart{name: "file", filename: "lib.epub", data: string(f.data)})
	problem = decodeBody[map[string]any](t, library)
	if library.StatusCode != http.StatusUnsupportedMediaType || problem["duplicate_of_book_id"] != nil {
		t.Fatalf("catalog bytes without a destination must still be validated: %d %v", library.StatusCode, problem)
	}
	for _, test := range []struct {
		name  string
		parts []uploadPart
		want  int
	}{
		{"unsupported", []uploadPart{{name: "file", filename: "bad.epub", data: "not an ebook"}}, 415},
		{"too-large", []uploadPart{{name: "file", filename: "big.epub", data: strings.Repeat("x", 1<<20+1)}}, 413},
		{"bad-name", []uploadPart{{name: "file", filename: "../x.epub", data: heapEPUB(t, "n")}}, 400},
		{"no-file", nil, 400},
		{"two-files", []uploadPart{{name: "file", filename: "b.epub", data: heapEPUB(t, "b")}, {name: "file", filename: "c.epub", data: heapEPUB(t, "c")}}, 400},
		{"extra-part", []uploadPart{{name: "file", filename: "d.epub", data: heapEPUB(t, "d")}, {name: "library_id", data: "10"}}, 400},
	} {
		t.Run(test.name, func(t *testing.T) {
			if response := f.heapUpload(t, test.parts...); response.StatusCode != test.want {
				t.Fatalf("status %d", response.StatusCode)
			}
		})
	}
	entries, err := os.ReadDir(heap)
	if err != nil || len(entries) != 1 || entries[0].Name() != "My Book.epub" {
		t.Fatalf("heap entries %v %v", entries, err)
	}

	list := f.request(http.MethodGet, "/api/v1/admin/bookheap/items?status=ready&q=fixture&limit=10", nil, f.admin, nil)
	page := map[string]any{}
	if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil || list.Code != 200 || page["total"] != float64(1) || page["next_cursor"] != nil {
		t.Fatalf("list %d %s", list.Code, list.Body.String())
	}
	if response := f.request(http.MethodGet, "/api/v1/admin/bookheap/items?status=nope", nil, f.admin, nil); response.Code != 400 {
		t.Fatalf("bad status %d", response.Code)
	}
	if response := f.request(http.MethodGet, "/api/v1/admin/bookheap/items/1", nil, f.admin, nil); response.Code != 200 ||
		!strings.Contains(response.Body.String(), `"item":`) {
		t.Fatalf("get %d %s", response.Code, response.Body.String())
	}
	if response := f.request(http.MethodGet, "/api/v1/admin/bookheap/items/99", nil, f.admin, nil); response.Code != 404 {
		t.Fatalf("missing %d", response.Code)
	}
	for _, target := range []string{"/api/v1/admin/bookheap/items/1/cover", "/api/v1/admin/bookheap/items/1/cover?thumbnail=1"} {
		if response := f.request(http.MethodGet, target, nil, f.admin, nil); response.Code != 200 || response.Header().Get("Content-Type") != "image/jpeg" ||
			response.Header().Get("ETag") == "" {
			t.Fatalf("cover %s: %d", target, response.Code)
		}
	}
	if response := f.request(http.MethodGet, "/api/v1/admin/bookheap/items/1/cover?thumbnail=2", nil, f.admin, nil); response.Code != 400 {
		t.Fatalf("cover param %d", response.Code)
	}

	for _, body := range []string{`{"ids":[]}`, `{"ids":[1,1]}`, `{"ids":[1],"x":1}`, `{}`} {
		if response := f.request(http.MethodPost, "/api/v1/admin/bookheap/items/delete", strings.NewReader(body), f.admin, map[string]string{"Content-Type": "application/json"}); response.Code != 400 {
			t.Fatalf("delete %s: %d", body, response.Code)
		}
	}
	deleted := f.request(http.MethodPost, "/api/v1/admin/bookheap/items/delete", strings.NewReader(`{"ids":[1,77]}`), f.admin, map[string]string{"Content-Type": "application/json"})
	if deleted.Code != 200 || strings.TrimSpace(deleted.Body.String()) != `{"results":[{"id":1,"ok":true,"error":null},{"id":77,"ok":false,"error":"not_found"}]}` {
		t.Fatalf("delete %d %s", deleted.Code, deleted.Body.String())
	}
	if entries, err := os.ReadDir(heap); err != nil || len(entries) != 0 {
		t.Fatalf("heap after delete %v %v", entries, err)
	}
}

func TestBookheapHTTPScan(t *testing.T) {
	f, heap := bookheapFixture(t, 1<<20)
	if response := f.request(http.MethodGet, "/api/v1/admin/bookheap/scan", nil, f.admin, nil); response.Code != 200 ||
		strings.TrimSpace(response.Body.String()) != `{"scan":null}` {
		t.Fatalf("initial %d %s", response.Code, response.Body.String())
	}
	path := filepath.Join(heap, "dropped.epub")
	if err := os.WriteFile(path, []byte(heapEPUB(t, "s")), 0o640); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	started := f.request(http.MethodPost, "/api/v1/admin/bookheap/scan", nil, f.admin, nil)
	if started.Code != http.StatusAccepted && started.Code != http.StatusOK {
		t.Fatalf("start %d %s", started.Code, started.Body.String())
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		response := f.request(http.MethodGet, "/api/v1/admin/bookheap/scan", nil, f.admin, nil)
		var body struct{ Scan bookheap.Scan }
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Scan.Status == bookheap.ScanCompleted {
			if body.Scan.Added != 1 || strings.Contains(response.Body.String(), heap) {
				t.Fatalf("scan %s", response.Body.String())
			}
			break
		}
		if body.Scan.Status == bookheap.ScanFailed || time.Now().After(deadline) {
			t.Fatalf("scan %s", response.Body.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if response := f.request(http.MethodPost, "/api/v1/admin/bookheap/scan", strings.NewReader("x"), f.admin, nil); response.Code != 400 {
		t.Fatalf("scan with body %d", response.Code)
	}
}
