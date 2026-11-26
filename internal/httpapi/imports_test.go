package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/importer"
)

func importFixture(t *testing.T, limit int64) (catalogHTTPFixture, *importer.Service, string) {
	t.Helper()
	f := newCatalogHTTPFixture(t)
	root := t.TempDir()
	blobs, err := blobstore.New(root)
	if err != nil {
		t.Fatal(err)
	}
	catalogService, err := catalog.NewService(f.db.Writer, f.db.Reader, blobs)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := importer.New(importer.Options{Writer: f.db.Writer, Reader: f.db.Reader, Blobs: blobs, Catalog: catalogService,
		DataDir: root, DropDir: filepath.Join(root, "drop"), MaxBytes: limit, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := service.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	authentication, err := auth.NewService(context.Background(), f.db.Writer, f.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	f.router, err = NewRouter(RouterOptions{Database: f.db.Reader, Ready: func() bool { return true }, Logger: logger, MaxBodyBytes: limit,
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("test")}}, Mounts: []Mount{ImportMount(service, catalogService, authentication, logger)}})
	if err != nil {
		t.Fatal(err)
	}
	return f, service, root
}

type uploadPart struct{ name, filename, data string }

func multipartBody(t *testing.T, parts ...uploadPart) ([]byte, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, part := range parts {
		params := map[string]string{"name": part.name}
		if part.filename != "" {
			params["filename"] = part.filename
		}
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", mime.FormatMediaType("form-data", params))
		field, err := writer.CreatePart(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(field, part.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body.Bytes(), writer.FormDataContentType()
}

func TestImportHTTPAuthorizationAndMultipartValidation(t *testing.T) {
	f, _, root := importFixture(t, 1<<20)
	valid := []uploadPart{{name: "library_id", data: "10"}, {name: "file", filename: "The Book.fb2", data: `<FictionBook><description><title-info/></description></FictionBook>`}}
	for _, test := range []struct {
		name    string
		parts   []uploadPart
		cookie  *http.Cookie
		target  string
		want    int
		headers map[string]string
	}{
		{"unauthenticated", valid, nil, "/api/v1/uploads", 401, nil},
		{"reader", valid, f.reader, "/api/v1/uploads", 403, nil},
		{"cross-origin", valid, f.admin, "/api/v1/uploads", 403, map[string]string{"Sec-Fetch-Site": "cross-site"}},
		{"missing-file", valid[:1], f.admin, "/api/v1/uploads", 400, nil},
		{"missing-library", valid[1:], f.admin, "/api/v1/uploads", 400, nil},
		{"bad-library", []uploadPart{{name: "library_id", data: "-1"}, valid[1]}, f.admin, "/api/v1/uploads", 400, nil},
		{"missing-library-row", []uploadPart{{name: "library_id", data: "9999"}, valid[1]}, f.admin, "/api/v1/uploads", 404, nil},
		{"extra-part", append(append([]uploadPart{}, valid...), uploadPart{name: "unexpected", data: "x"}), f.admin, "/api/v1/uploads", 400, nil},
		{"two-files", append(append([]uploadPart{}, valid...), valid[1]), f.admin, "/api/v1/uploads", 400, nil},
		{"path-filename", []uploadPart{valid[0], {name: "file", filename: "../book.fb2", data: "x"}}, f.admin, "/api/v1/uploads", 400, nil},
		{"empty-file", []uploadPart{valid[0], {name: "file", filename: "empty.epub"}}, f.admin, "/api/v1/uploads", 400, nil},
		{"hidden-book", valid[1:], f.admin, "/api/v1/books/103/files", 404, nil},
		{"invalid-book-id", valid[1:], f.admin, "/api/v1/books/no/files", 400, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			body, contentType := multipartBody(t, test.parts...)
			headers := map[string]string{"Content-Type": contentType}
			for key, value := range test.headers {
				headers[key] = value
			}
			response := f.request(http.MethodPost, test.target, bytes.NewReader(body), test.cookie, headers)
			if response.Code != test.want || !strings.Contains(response.Header().Get("Content-Type"), "application/problem+json") {
				t.Fatalf("response %d %s", response.Code, response.Body.String())
			}
		})
	}
	entries, err := os.ReadDir(filepath.Join(root, "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			t.Errorf("leaked upload: %s", entry.Name())
		}
	}
	var count int
	if err := f.db.Reader.QueryRow(`SELECT count(*) FROM import_jobs`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid jobs persisted %d %v", count, err)
	}
}

func TestImportHTTPAcceptedHistoryAndAttachment(t *testing.T) {
	f, service, _ := importFixture(t, 1<<20)
	data := `<FictionBook><description><title-info><book-title>Imported Fixture</book-title></title-info></description></FictionBook>`
	body, contentType := multipartBody(t, uploadPart{name: "file", filename: "Book.fb2", data: data}, uploadPart{name: "library_id", data: "10"})
	response := f.request(http.MethodPost, "/api/v1/uploads", bytes.NewReader(body), f.admin, map[string]string{"Content-Type": contentType})
	if response.Code != 202 {
		t.Fatalf("upload %d %s", response.Code, response.Body.String())
	}
	var accepted struct {
		Job importer.Job `json:"job"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &accepted); err != nil || accepted.Job.Status != "pending" || accepted.Job.ID < 1 {
		t.Fatalf("accepted %+v %v", accepted, err)
	}
	body, contentType = multipartBody(t, uploadPart{name: "file", filename: "Another.fb2", data: strings.ReplaceAll(data, "Imported Fixture", "Attachment Fixture")})
	attachment := f.request(http.MethodPost, "/api/v1/books/101/files", bytes.NewReader(body), f.admin, map[string]string{"Content-Type": contentType})
	if attachment.Code != 202 {
		t.Fatalf("attachment %d %s", attachment.Code, attachment.Body.String())
	}
	if err := service.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var count int
		if err := f.db.Reader.QueryRow(`SELECT count(*) FROM import_jobs WHERE status='imported'`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 2 {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("imports did not finish")
		case <-ticker.C:
		}
	}
	var count int
	if err := f.db.Reader.QueryRow(`SELECT count(*) FROM book_files WHERE book_id=101`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("attachment file count %d %v", count, err)
	}
	history := f.request(http.MethodGet, "/api/v1/imports?limit=1", nil, f.admin, nil)
	if history.Code != 200 || !strings.Contains(history.Body.String(), `"next_cursor":"`) {
		t.Fatalf("history %d %s", history.Code, history.Body.String())
	}
	for _, target := range []string{"/api/v1/imports?limit=101", "/api/v1/imports?cursor=-1", "/api/v1/imports?limit=1&limit=2", "/api/v1/imports?unknown=1", "/api/v1/imports?q=", "/api/v1/imports?q=one&q=two"} {
		if response := f.request(http.MethodGet, target, nil, f.admin, nil); response.Code != 400 {
			t.Errorf("%s: %d", target, response.Code)
		}
	}
	if response := f.request(http.MethodGet, "/api/v1/imports", nil, f.reader, nil); response.Code != 403 {
		t.Fatal(response.Code)
	}
}

func TestImportHistorySearchBookStateAndUploader(t *testing.T) {
	f, _, _ := importFixture(t, 1<<20)
	for _, statement := range []string{
		`INSERT INTO import_jobs (id, source, library_id, user_id, original_name, status, book_id, created_at, finished_at) VALUES
			(1, 'upload', 10, 1, 'visible.epub', 'imported', 101, 1000, 1100),
			(2, 'upload', 10, 1, 'deleted.epub', 'imported', 102, 2000, 2100),
			(3, 'upload', 10, 2, 'reader.epub', 'failed', NULL, 3000, NULL),
			(4, 'upload', 10, 1, 'secret.epub', 'imported', 103, 4000, 4100),
			(5, 'upload', 10, 1, 'purged.epub', 'imported', NULL, 5000, 5100)`,
		`UPDATE books SET deleted_at = 2200 WHERE id = 102`,
	} {
		if _, err := f.db.Writer.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	type historyItem struct {
		BookID      *int64  `json:"book_id"`
		BookTitle   *string `json:"book_title"`
		BookDeleted bool    `json:"book_deleted"`
		UploadedBy  *string `json:"uploaded_by"`
	}
	type historyPage struct {
		Items []historyItem `json:"items"`
	}
	fetch := func(search string) historyPage {
		t.Helper()
		response := f.request(http.MethodGet, "/api/v1/imports?limit=50&q="+search, nil, f.admin, nil)
		if response.Code != http.StatusOK {
			t.Fatalf("search %q: %d %s", search, response.Code, response.Body.String())
		}
		var page historyPage
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}

	visible := fetch("visible")
	if len(visible.Items) != 1 || visible.Items[0].BookID == nil || *visible.Items[0].BookID != 101 ||
		visible.Items[0].BookTitle == nil || *visible.Items[0].BookTitle != "Visible" || visible.Items[0].BookDeleted ||
		visible.Items[0].UploadedBy == nil || *visible.Items[0].UploadedBy != "admin" {
		t.Fatalf("visible book: %+v", visible)
	}

	deleted := fetch("deleted")
	if len(deleted.Items) != 1 || deleted.Items[0].BookID != nil || deleted.Items[0].BookTitle == nil ||
		*deleted.Items[0].BookTitle != "Hidden" || !deleted.Items[0].BookDeleted ||
		deleted.Items[0].UploadedBy == nil || *deleted.Items[0].UploadedBy != "admin" {
		t.Fatalf("deleted book: %+v", deleted)
	}

	purged := fetch("purged")
	if len(purged.Items) != 1 || purged.Items[0].BookID != nil || purged.Items[0].BookTitle != nil ||
		!purged.Items[0].BookDeleted {
		t.Fatalf("purged book: %+v", purged)
	}

	reader := fetch("reader")
	if len(reader.Items) != 1 || reader.Items[0].UploadedBy == nil || *reader.Items[0].UploadedBy != "reader" {
		t.Fatalf("uploader search: %+v", reader)
	}

	if byID := fetch("3"); len(byID.Items) != 1 {
		t.Fatalf("job ID search: %+v", byID)
	}

	secret := fetch("secret")
	if len(secret.Items) != 1 || secret.Items[0].BookID != nil || secret.Items[0].BookTitle != nil || secret.Items[0].BookDeleted {
		t.Fatalf("hidden book leaked metadata: %+v", secret)
	}

	if none := fetch("absent"); len(none.Items) != 0 {
		t.Fatalf("unexpected matches: %+v", none)
	}
	long := f.request(http.MethodGet, "/api/v1/imports?q="+strings.Repeat("x", 257), nil, f.admin, nil)
	if long.Code != http.StatusBadRequest {
		t.Fatalf("long search: %d %s", long.Code, long.Body.String())
	}
}

func TestImportHTTPStreamingLimitAndTruncation(t *testing.T) {
	f, _, root := importFixture(t, 4096)
	reader, writer := io.Pipe()
	multipartWriter := multipart.NewWriter(writer)
	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		defer writer.Close()
		if err := multipartWriter.WriteField("library_id", "10"); err != nil {
			return
		}
		file, err := multipartWriter.CreateFormFile("file", "large.fb2")
		if err != nil {
			return
		}
		if _, err := io.Copy(file, strings.NewReader(strings.Repeat("x", 16384))); err != nil {
			return
		}
		_ = multipartWriter.Close()
	}()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/uploads", reader)
	request.ContentLength = -1
	request.AddCookie(f.admin)
	request.Header.Set("Content-Type", multipartWriter.FormDataContentType())
	response := httptest.NewRecorder()
	f.router.ServeHTTP(response, request)
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	<-writeDone
	if response.Code != 413 {
		t.Fatalf("streamed limit %d %s", response.Code, response.Body.String())
	}
	body, contentType := multipartBody(t, uploadPart{name: "library_id", data: "10"}, uploadPart{name: "file", filename: "bad.fb2", data: "content"})
	truncated := f.request(http.MethodPost, "/api/v1/uploads", bytes.NewReader(body[:len(body)-20]), f.admin, map[string]string{"Content-Type": contentType})
	if truncated.Code != 400 {
		t.Fatalf("truncated %d %s", truncated.Code, truncated.Body.String())
	}
	entries, err := os.ReadDir(filepath.Join(root, "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			t.Errorf("leaked temporary %s", entry.Name())
		}
	}
}
