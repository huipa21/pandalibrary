package httpapi

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"testing/fstest"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/bookheap"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/importer"
)

type bookheapAssignHTTPFixture struct {
	catalogHTTPFixture
	heap     *bookheap.Service
	dir      string
	catalog  *catalog.Service
	importer *importer.Service
}

func newBookheapAssignHTTPFixture(t *testing.T) bookheapAssignHTTPFixture {
	t.Helper()
	f := newCatalogHTTPFixture(t)
	root := t.TempDir()
	blobs, err := blobstore.New(root)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	catalogService, err := catalog.NewService(f.db.Writer, f.db.Reader, blobs)
	if err != nil {
		t.Fatal(err)
	}
	importService, err := importer.New(importer.Options{Writer: f.db.Writer, Reader: f.db.Reader, Blobs: blobs, Catalog: catalogService,
		DataDir: root, DropDir: filepath.Join(root, "drop"), MaxBytes: 1 << 20, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "bookheap")
	service, err := bookheap.New(bookheap.Options{Writer: f.db.Writer, Reader: f.db.Reader, Blobs: blobs, Dir: dir,
		MaxBytes: 1 << 20, Logger: logger, Importer: importService, Catalog: catalogService})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := importService.Stop(ctx); err != nil {
			t.Error(err)
		}
		if err := service.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	authentication, err := auth.NewService(context.Background(), f.db.Writer, f.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	f.router, err = NewRouter(RouterOptions{Database: f.db.Reader, Ready: func() bool { return true }, Logger: logger, MaxBodyBytes: 2 << 20,
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("test")}},
		Mounts: []Mount{BookheapMount(service, authentication, logger), BookheapAssignMount(service, authentication, logger)}})
	if err != nil {
		t.Fatal(err)
	}
	return bookheapAssignHTTPFixture{catalogHTTPFixture: f, heap: service, dir: dir, catalog: catalogService, importer: importService}
}

func (f bookheapAssignHTTPFixture) assign(body string, cookie *http.Cookie, headers map[string]string) *http.Response {
	if headers == nil {
		headers = map[string]string{"Content-Type": "application/json"}
	}
	return f.request(http.MethodPost, "/api/v1/admin/bookheap/assign", bytes.NewReader([]byte(body)), cookie, headers).Result()
}

func TestBookheapAssignHTTP(t *testing.T) {
	f := newBookheapAssignHTTPFixture(t)
	ctx := context.Background()
	admin, reader := catalog.Viewer{UserID: 1, IsAdmin: true}, catalog.Viewer{UserID: 2}
	var ids []int64
	for _, name := range []string{"a.epub", "b.epub"} {
		response := f.heapUpload(t, uploadPart{name: "file", filename: name, data: heapEPUB(t, name)})
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("upload %d", response.StatusCode)
		}
		ids = append(ids, int64(decodeBody[map[string]map[string]any](t, response)["item"]["id"].(float64)))
	}
	shared, err := f.catalog.CreateShelf(ctx, admin, catalog.ShelfInput{Kind: "shared", Name: "Shared"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := f.catalog.CreateShelf(ctx, reader, catalog.ShelfInput{Kind: "private", Name: "Theirs"})
	if err != nil {
		t.Fatal(err)
	}
	idList := strconv.FormatInt(ids[0], 10) + "," + strconv.FormatInt(ids[1], 10)
	sharedID, theirsID := strconv.FormatInt(shared.ID, 10), strconv.FormatInt(theirs.ID, 10)

	for _, test := range []struct {
		name    string
		body    string
		cookie  *http.Cookie
		headers map[string]string
		want    int
		shelf   float64
	}{
		{"unauthenticated", `{"ids":[1],"library_id":10}`, nil, nil, 401, 0},
		{"reader", `{"ids":[1],"library_id":10}`, f.reader, nil, 403, 0},
		{"cross-site", `{"ids":[1],"library_id":10}`, f.admin, map[string]string{"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"}, 403, 0},
		{"unknown field", `{"ids":[1],"library_id":10,"x":1}`, f.admin, nil, 400, 0},
		{"wrong type", `{"ids":["1"],"library_id":10}`, f.admin, nil, 400, 0},
		{"no ids", `{"ids":[],"library_id":10}`, f.admin, nil, 400, 0},
		{"duplicate ids", `{"ids":[1,1],"library_id":10}`, f.admin, nil, 400, 0},
		{"missing library", `{"ids":[1],"library_id":99}`, f.admin, nil, 404, 0},
		{"missing shelf", `{"ids":[1],"library_id":10,"shelf_ids":[` + sharedID + `,9999]}`, f.admin, nil, 404, 9999},
		{"other private shelf", `{"ids":[1],"library_id":10,"shelf_ids":[` + theirsID + `]}`, f.admin, nil, 400, float64(theirs.ID)},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := f.assign(test.body, test.cookie, test.headers)
			if response.StatusCode != test.want {
				t.Fatalf("status %d", response.StatusCode)
			}
			if test.shelf != 0 {
				if problem := decodeBody[map[string]any](t, response); problem["shelf_id"] != test.shelf {
					t.Fatalf("problem %v", problem)
				}
			}
		})
	}
	var jobs int
	if err := f.db.Reader.QueryRow(`SELECT count(*) FROM import_jobs`).Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("jobs = %d, %v", jobs, err)
	}

	response := f.assign(`{"ids":[`+idList+`,9999],"library_id":10,"shelf_ids":[`+sharedID+`]}`, f.admin, nil)
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("assign %d", response.StatusCode)
	}
	results := decodeBody[map[string][]map[string]any](t, response)["results"]
	if len(results) != 3 || results[0]["ok"] != true || results[0]["error"] != nil || results[0]["import_job_id"] == nil ||
		results[1]["ok"] != true || results[2]["ok"] != false || results[2]["error"] != bookheap.AssignNotFound || results[2]["import_job_id"] != nil {
		t.Fatalf("results %v", results)
	}
	again := decodeBody[map[string][]map[string]any](t, f.assign(`{"ids":[`+strconv.FormatInt(ids[0], 10)+`],"library_id":10}`, f.admin, nil))["results"]
	if again[0]["error"] != bookheap.AssignNotAssignable {
		t.Fatalf("again %v", again)
	}

	if err := f.importer.Start(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		entries, err := os.ReadDir(f.dir)
		var items, members int
		if err == nil {
			err = f.db.Reader.QueryRow(`SELECT (SELECT count(*) FROM bookheap_items), (SELECT count(*) FROM shelf_books WHERE shelf_id = ?)`, shared.ID).Scan(&items, &members)
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) == 0 && items == 0 && members == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("assignment did not finish: %d files, %d items, %d members", len(entries), items, members)
		}
		time.Sleep(10 * time.Millisecond)
	}
	var imported int
	if err := f.db.Reader.QueryRow(`SELECT count(*) FROM import_jobs WHERE source = 'bookheap' AND status = 'imported' AND library_id = 10`).Scan(&imported); err != nil || imported != 2 {
		t.Fatalf("imported = %d, %v", imported, err)
	}
}
