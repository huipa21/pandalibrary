package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/covers"
	"pandalibrary/internal/db"
)

type catalogHTTPFixture struct {
	router http.Handler
	db     *db.DB
	admin  *http.Cookie
	reader *http.Cookie
	other  *http.Cookie
	data   []byte
	hash   string
}

func newCatalogHTTPFixture(t *testing.T) catalogHTTPFixture {
	t.Helper()
	ctx := context.Background()
	databases := openHTTPTestDatabase(t)
	root := t.TempDir()
	store, err := blobstore.New(root)
	if err != nil {
		t.Fatal(err)
	}
	service, err := catalog.NewService(databases.Writer, databases.Reader, store)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("example ebook bytes for range requests")
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	bookPath, err := blobstore.BookPath(hash, "epub")
	if err != nil {
		t.Fatal(err)
	}
	absolute := filepath.Join(root, bookPath)
	if err := os.MkdirAll(filepath.Dir(absolute), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(absolute, data, 0o600); err != nil {
		t.Fatal(err)
	}
	imageBytes := testPNG(t, color.RGBA{R: 220, G: 20, B: 30, A: 255})
	normalized, err := covers.Normalize(imageBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.PublishCover(normalized.FullSHA256, normalized.FullJPEG, normalized.ThumbnailJPEG); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO users (id, username, display_name, password_hash, role, locale, created_at, updated_at) VALUES
			(1, 'admin', 'Admin', 'test', 'admin', 'en', 1, 1),
			(2, 'reader', 'Reader', 'test', 'user', 'en', 1, 1),
			(3, 'other', 'Other', 'test', 'user', 'en', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1), (30, 'Empty', 'empty', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1), (20, 3, 1)`,
		`INSERT INTO authors (id, name, sort_name, created_at) VALUES
			(1, 'Shared Author', 'Shared Author', 1), (2, 'Secret Author', 'Secret Author', 1)`,
		`INSERT INTO series (id, name, created_at) VALUES (1, 'Visible Series', 1), (2, 'Secret Series', 1)`,
		`INSERT INTO tags (id, name, created_at) VALUES (1, 'Visible Tag', 1), (2, 'Secret Tag', 1)`,
		fmt.Sprintf(`INSERT INTO books (id, library_id, title, sort_title, series_id, series_index, cover_sha256, created_at, updated_at)
			VALUES (101, 10, 'Visible', 'visible', 1, 1, '%s', 100, 100),
			(102, 10, 'Hidden', 'hidden', 1, 2, '%s', 100, 100),
			(103, 20, 'Secret', 'secret', 2, 1, '%s', 100, 100)`,
			normalized.FullSHA256, normalized.FullSHA256, normalized.FullSHA256),
		`INSERT INTO book_authors (book_id, author_id, role, position) VALUES
			(101, 1, 'author', 0), (102, 1, 'author', 0), (103, 2, 'author', 0)`,
		`INSERT INTO book_tags (book_id, tag_id) VALUES (101, 1), (102, 1), (103, 2)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 102, 1, 1), (1, 103, 1, 1)`,
	}
	for _, statement := range statements {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed catalog: %v", err)
		}
	}
	if _, err := databases.Writer.ExecContext(ctx, `
		INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
		VALUES (201, 101, ?, 'epub', ?, ?, 1)`, hash, len(data), "..\\evil\r\nInjected.epub"); err != nil {
		t.Fatal(err)
	}
	for _, file := range []struct {
		id       int64
		bookID   int64
		filename string
		data     []byte
	}{
		{202, 102, "hidden.pdf", []byte("hidden ebook")},
		{203, 103, "secret.pdf", []byte("secret ebook")},
	} {
		sum := sha256.Sum256(file.data)
		fileHash := hex.EncodeToString(sum[:])
		name, err := blobstore.BookPath(fileHash, "pdf")
		if err != nil {
			t.Fatal(err)
		}
		absolute := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(absolute), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, file.data, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := databases.Writer.ExecContext(ctx, `
			INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
			VALUES (?, ?, ?, 'pdf', ?, ?, 1)`, file.id, file.bookID, fileHash, len(file.data), file.filename); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	cookies := make([]*http.Cookie, 0, 3)
	for id := 1; id <= 3; id++ {
		token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{byte(id)}, 32))
		tokenHash := sha256.Sum256([]byte(token))
		if _, err := databases.Writer.ExecContext(ctx, `
			INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?)`, tokenHash[:], id, now.UnixMilli(),
			now.Add(24*time.Hour).UnixMilli(), now.UnixMilli()); err != nil {
			t.Fatal(err)
		}
		cookies = append(cookies, &http.Cookie{Name: sessionCookieName, Value: token})
	}
	authentication, err := auth.NewService(ctx, databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router, err := NewRouter(RouterOptions{
		Database: databases.Reader, Ready: func() bool { return true },
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<!doctype html><title>test</title>")}},
		Logger: logger, MaxBodyBytes: 32 << 20,
		Mounts: []Mount{AuthMount(authentication, logger), CatalogMount(service, authentication, logger)},
	})
	if err != nil {
		t.Fatal(err)
	}
	return catalogHTTPFixture{
		router: router, db: databases, admin: cookies[0], reader: cookies[1], other: cookies[2],
		data: data, hash: hash,
	}
}

func testPNG(t *testing.T, fill color.RGBA) []byte {
	t.Helper()
	image := image.NewRGBA(image.Rect(0, 0, 500, 700))
	for y := 0; y < 700; y++ {
		for x := 0; x < 500; x++ {
			image.SetRGBA(x, y, fill)
		}
	}
	var result bytes.Buffer
	if err := png.Encode(&result, image); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func (f catalogHTTPFixture) request(method, target string, body io.Reader, cookie *http.Cookie, headers map[string]string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, body)
	request.RemoteAddr = "192.0.2.10:54321"
	if cookie != nil {
		request.AddCookie(cookie)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	f.router.ServeHTTP(response, request)
	return response
}

func TestCatalogHTTPVisibilityAndRouting(t *testing.T) {
	fixture := newCatalogHTTPFixture(t)
	for _, test := range []struct {
		name   string
		cookie *http.Cookie
		want   []int64
	}{
		{"reader", fixture.reader, []int64{101}},
		{"admin", fixture.admin, []int64{102, 101}},
		{"other", fixture.other, []int64{103}},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := fixture.request(http.MethodGet, "/api/v1/books", nil, test.cookie, nil)
			if response.Code != http.StatusOK {
				t.Fatalf("books response = %d %s", response.Code, response.Body.String())
			}
			var page catalog.Page[catalog.Book]
			if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
				t.Fatal(err)
			}
			if len(page.Items) != len(test.want) {
				t.Fatalf("visible books = %+v, want %v", page.Items, test.want)
			}
			for _, secret := range []string{"password_hash", `"sha256":`, `"token_hash":`, `\\`, "..", `\r`} {
				if strings.Contains(response.Body.String(), secret) {
					t.Errorf("book list exposed %q: %s", secret, response.Body.String())
				}
			}
			for _, item := range page.Items {
				for _, file := range item.Files {
					if file.OriginalFilename == "" || strings.ContainsAny(file.OriginalFilename, `/\`) ||
						file.CreatedAt.Location() != time.UTC || file.CreatedAt.UnixMilli() != 1 {
						t.Errorf("book %d file = %+v", item.ID, file)
					}
				}
			}
			for i, id := range test.want {
				if page.Items[i].ID != id {
					t.Fatalf("visible books = %+v, want %v", page.Items, test.want)
				}
			}
		})
	}
	for _, target := range []string{
		"/api/v1/books/102", "/api/v1/books/103", "/api/v1/books/102/files/202",
		"/api/v1/books/103/cover", "/api/v1/authors/2", "/api/v1/series/2", "/api/v1/tags/2",
	} {
		response := fixture.request(http.MethodGet, target, nil, fixture.reader, map[string]string{"If-None-Match": "*"})
		requireProblem(t, response, http.StatusNotFound)
	}
	detail := fixture.request(http.MethodGet, "/api/v1/books/101", nil, fixture.reader, nil)
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(),
		`"original_filename":"evil__Injected.epub","created_at":"1970-01-01T00:00:00.001Z"}`) {
		t.Fatalf("book detail file fields = %d %s", detail.Code, detail.Body.String())
	}
	authors := fixture.request(http.MethodGet, "/api/v1/authors", nil, fixture.reader, nil)
	if authors.Code != http.StatusOK || strings.Contains(authors.Body.String(), "Secret Author") ||
		!strings.Contains(authors.Body.String(), `"visible_book_count":1`) {
		t.Fatalf("author visibility = %d %s", authors.Code, authors.Body.String())
	}
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/books", nil, nil, nil), http.StatusUnauthorized)
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/admin/libraries", nil, fixture.reader, nil), http.StatusForbidden)
	requireProblem(t, fixture.request(http.MethodPatch, "/api/v1/books/101", strings.NewReader(`{"title":"No"}`),
		fixture.admin, map[string]string{"Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"}), http.StatusForbidden)
	authMe := fixture.request(http.MethodGet, "/api/v1/auth/me", nil, fixture.admin, nil)
	if authMe.Code != http.StatusOK || !strings.Contains(authMe.Body.String(), `"username":"admin"`) {
		t.Fatalf("existing auth route = %d %s", authMe.Code, authMe.Body.String())
	}
}

func TestCatalogHTTPVisibilityMatrix(t *testing.T) {
	fixture := newCatalogHTTPFixture(t)
	for _, viewer := range []struct {
		name    string
		cookie  *http.Cookie
		visible map[int64]bool
	}{
		{"admin", fixture.admin, map[int64]bool{101: true, 102: true}},
		{"reader", fixture.reader, map[int64]bool{101: true}},
		{"other", fixture.other, map[int64]bool{103: true}},
	} {
		t.Run(viewer.name, func(t *testing.T) {
			for _, id := range []int64{101, 102, 103, 999} {
				for _, target := range []string{
					fmt.Sprintf("/api/v1/books/%d", id),
					fmt.Sprintf("/api/v1/books/%d/files/%d", id, id+100),
					fmt.Sprintf("/api/v1/books/%d/cover", id),
					fmt.Sprintf("/api/v1/books/%d/cover?w=400", id),
				} {
					response := fixture.request(http.MethodGet, target, nil, viewer.cookie, nil)
					if viewer.visible[id] {
						if response.Code != http.StatusOK {
							t.Errorf("%s = %d %s, want 200", target, response.Code, response.Body.String())
						}
					} else {
						requireProblem(t, response, http.StatusNotFound)
					}
				}
			}
			for _, filter := range []struct {
				query string
				ids   map[int64]bool
			}{
				{"library_id=10", map[int64]bool{101: true, 102: true}},
				{"library_id=20", map[int64]bool{103: true}},
				{"author_id=1", map[int64]bool{101: true, 102: true}},
				{"author_id=2", map[int64]bool{103: true}},
				{"series_id=1", map[int64]bool{101: true, 102: true}},
				{"series_id=2", map[int64]bool{103: true}},
				{"tag_id=1", map[int64]bool{101: true, 102: true}},
				{"tag_id=2", map[int64]bool{103: true}},
				{"series_id=1&sort=series", map[int64]bool{101: true, 102: true}},
			} {
				response := fixture.request(http.MethodGet, "/api/v1/books?"+filter.query, nil, viewer.cookie, nil)
				var page catalog.Page[catalog.Book]
				if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != http.StatusOK {
					t.Fatalf("filter %s = %d %s, %v", filter.query, response.Code, response.Body.String(), err)
				}
				want := 0
				for id := range filter.ids {
					if viewer.visible[id] {
						want++
					}
				}
				if len(page.Items) != want {
					t.Errorf("filter %s returned %d books, want %d", filter.query, len(page.Items), want)
				}
				for _, book := range page.Items {
					if !filter.ids[book.ID] || !viewer.visible[book.ID] {
						t.Errorf("filter %s leaked book %d", filter.query, book.ID)
					}
				}
			}
			for _, kind := range []string{"authors", "series", "tags"} {
				expected := map[int64]int64{}
				for id := range viewer.visible {
					entityID := int64(1)
					if id == 103 {
						entityID = 2
					}
					expected[entityID]++
				}
				list := fixture.request(http.MethodGet, "/api/v1/"+kind, nil, viewer.cookie, nil)
				var page catalog.Page[catalog.Entity]
				if err := json.Unmarshal(list.Body.Bytes(), &page); err != nil || list.Code != http.StatusOK || len(page.Items) != len(expected) {
					t.Fatalf("%s list = %d %s, %v", kind, list.Code, list.Body.String(), err)
				}
				for _, entity := range page.Items {
					if expected[entity.ID] != entity.VisibleBookCount {
						t.Errorf("%s entity = %+v, want %v", kind, entity, expected)
					}
				}
				for _, id := range []int64{1, 2, 999} {
					response := fixture.request(http.MethodGet, fmt.Sprintf("/api/v1/%s/%d", kind, id), nil, viewer.cookie, nil)
					if _, ok := expected[id]; ok {
						if response.Code != http.StatusOK {
							t.Errorf("%s/%d = %d %s", kind, id, response.Code, response.Body.String())
						}
					} else {
						requireProblem(t, response, http.StatusNotFound)
					}
				}
			}
		})
	}
	pdf := fixture.request(http.MethodGet, "/api/v1/books/103/files/203", nil, fixture.other, nil)
	if pdf.Code != http.StatusOK || pdf.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("PDF = %d %v", pdf.Code, pdf.Header())
	}
}

func TestCatalogHTTPFileAndCoverServing(t *testing.T) {
	fixture := newCatalogHTTPFixture(t)
	fileURL := "/api/v1/books/101/files/201"
	response := fixture.request(http.MethodGet, fileURL, nil, fixture.reader, nil)
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), fixture.data) {
		t.Fatalf("file response = %d %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "application/epub+zip" ||
		response.Header().Get("ETag") != `"`+fixture.hash+`"` ||
		response.Header().Get("Cache-Control") != "private, no-cache" ||
		response.Header().Get("Last-Modified") != "" ||
		!strings.Contains(response.Header().Get("Vary"), "Cookie") ||
		response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("file headers = %v", response.Header())
	}
	disposition := response.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disposition, "attachment") || strings.ContainsAny(disposition, "\r\n") ||
		strings.Contains(disposition, "..") {
		t.Fatalf("unsafe content disposition %q", disposition)
	}
	versioned := fixture.request(http.MethodGet, fileURL+"?v="+fixture.hash, nil, fixture.reader, nil)
	if versioned.Code != http.StatusOK || !strings.Contains(versioned.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("versioned file = %d %v", versioned.Code, versioned.Header())
	}
	conditional := fixture.request(http.MethodGet, fileURL, nil, fixture.reader, map[string]string{"If-None-Match": `"` + fixture.hash + `"`})
	if conditional.Code != http.StatusNotModified || conditional.Body.Len() != 0 {
		t.Fatalf("conditional file = %d %s", conditional.Code, conditional.Body.String())
	}
	partial := fixture.request(http.MethodGet, fileURL, nil, fixture.reader, map[string]string{"Range": "bytes=0-6"})
	if partial.Code != http.StatusPartialContent || partial.Body.String() != string(fixture.data[:7]) {
		t.Fatalf("range response = %d %q", partial.Code, partial.Body.String())
	}
	invalidRange := fixture.request(http.MethodGet, fileURL, nil, fixture.reader, map[string]string{"Range": "bytes=9999-"})
	if invalidRange.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("invalid range = %d", invalidRange.Code)
	}
	head := fixture.request(http.MethodHead, fileURL, nil, fixture.reader, nil)
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("HEAD response = %d %q", head.Code, head.Body.String())
	}
	requireProblem(t, fixture.request(http.MethodGet, fileURL+"?v="+strings.Repeat("a", 64), nil, fixture.reader, nil), http.StatusNotFound)
	requireProblem(t, fixture.request(http.MethodGet, fileURL+"?v=bad", nil, fixture.reader, nil), http.StatusBadRequest)
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/books/101/files/202", nil, fixture.reader, nil), http.StatusNotFound)

	full := fixture.request(http.MethodGet, "/api/v1/books/101/cover", nil, fixture.reader, nil)
	thumb := fixture.request(http.MethodGet, "/api/v1/books/101/cover?w=400", nil, fixture.reader, nil)
	if full.Code != http.StatusOK || thumb.Code != http.StatusOK ||
		full.Header().Get("Content-Type") != "image/jpeg" ||
		full.Header().Get("ETag") == thumb.Header().Get("ETag") ||
		full.Header().Get("Last-Modified") != "" ||
		!strings.Contains(full.Header().Get("Vary"), "Cookie") {
		t.Fatalf("cover responses = %d %v, %d %v", full.Code, full.Header(), thumb.Code, thumb.Header())
	}
	thumbConditional := fixture.request(http.MethodGet, "/api/v1/books/101/cover?w=400", nil, fixture.reader,
		map[string]string{"If-None-Match": thumb.Header().Get("ETag")})
	if thumbConditional.Code != http.StatusNotModified || thumbConditional.Body.Len() != 0 {
		t.Fatalf("conditional thumbnail = %d %s", thumbConditional.Code, thumbConditional.Body.String())
	}
	coverHead := fixture.request(http.MethodHead, "/api/v1/books/101/cover", nil, fixture.reader, nil)
	if coverHead.Code != http.StatusOK || coverHead.Body.Len() != 0 {
		t.Fatalf("cover HEAD = %d %q", coverHead.Code, coverHead.Body.String())
	}
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/books/101/cover?w=200", nil, fixture.reader, nil), http.StatusBadRequest)
}

func TestCatalogHTTPMutationsAndValidation(t *testing.T) {
	fixture := newCatalogHTTPFixture(t)
	jsonHeaders := map[string]string{"Content-Type": "application/json"}
	created := fixture.request(http.MethodPost, "/api/v1/admin/libraries", strings.NewReader(`{"name":"Comics","slug":"comics"}`), fixture.admin, jsonHeaders)
	if created.Code != http.StatusCreated {
		t.Fatalf("create library = %d %s", created.Code, created.Body.String())
	}
	var library struct {
		Library catalog.Library `json:"library"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &library); err != nil {
		t.Fatal(err)
	}
	accessURL := fmt.Sprintf("/api/v1/admin/libraries/%d/access/2", library.Library.ID)
	for range 2 {
		response := fixture.request(http.MethodPut, accessURL, nil, fixture.admin, nil)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"granted":true`) {
			t.Fatalf("grant = %d %s", response.Code, response.Body.String())
		}
	}
	list := fixture.request(http.MethodGet, fmt.Sprintf("/api/v1/admin/libraries/%d/access", library.Library.ID), nil, fixture.admin, nil)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"user_id":2`) {
		t.Fatalf("access list = %d %s", list.Code, list.Body.String())
	}
	revoked := fixture.request(http.MethodDelete, accessURL, nil, fixture.admin, nil)
	if revoked.Code != http.StatusOK || !strings.Contains(revoked.Body.String(), `"revoked":true`) {
		t.Fatalf("revoke = %d %s", revoked.Code, revoked.Body.String())
	}
	hidden := fixture.request(http.MethodGet, "/api/v1/admin/users/1/hidden-books", nil, fixture.admin, nil)
	if hidden.Code != http.StatusOK || !strings.Contains(hidden.Body.String(), `"book_id":103`) ||
		strings.Contains(hidden.Body.String(), "Secret") {
		t.Fatalf("admin hide list = %d %s", hidden.Code, hidden.Body.String())
	}
	unhide := fixture.request(http.MethodDelete, "/api/v1/admin/users/1/hidden-books/103", nil, fixture.admin, nil)
	if unhide.Code != http.StatusOK || !strings.Contains(unhide.Body.String(), `"hidden":false`) {
		t.Fatalf("unhide = %d %s", unhide.Code, unhide.Body.String())
	}
	book := fixture.request(http.MethodPatch, "/api/v1/books/101",
		strings.NewReader(`{"title":"The 三体","tags":["New Tag"],"series":{"name":"Visible Series","index":1.5}}`), fixture.admin, jsonHeaders)
	if book.Code != http.StatusOK || !strings.Contains(book.Body.String(), `"sort_title":"santi, the"`) {
		t.Fatalf("update book = %d %s", book.Code, book.Body.String())
	}
	requireProblem(t, fixture.request(http.MethodPatch, "/api/v1/books/101",
		strings.NewReader(`{"series":{"name":"X","unknown":true}}`), fixture.admin, jsonHeaders), http.StatusBadRequest)
	requireProblem(t, fixture.request(http.MethodPatch, "/api/v1/books/101",
		strings.NewReader(`{"title":"Forbidden"}`), fixture.reader, jsonHeaders), http.StatusForbidden)
	requireProblem(t, fixture.request(http.MethodDelete, "/api/v1/admin/libraries/10", nil, fixture.admin, nil), http.StatusConflict)
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/books?limit=0", nil, fixture.reader, nil), http.StatusBadRequest)
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/books?series_id=1&sort=series&cursor=bad", nil, fixture.reader, nil), http.StatusBadRequest)

	imageBytes := testPNG(t, color.RGBA{R: 20, G: 30, B: 220, A: 255})
	before := fixture.request(http.MethodGet, "/api/v1/books/101/cover", nil, fixture.admin, nil)
	uploaded := fixture.request(http.MethodPut, "/api/v1/books/101/cover?source=pdfjs", bytes.NewReader(imageBytes),
		fixture.admin, map[string]string{"Content-Type": "image/png"})
	if uploaded.Code != http.StatusOK || !strings.Contains(uploaded.Body.String(), `"cover_source":"pdfjs"`) {
		t.Fatalf("upload cover = %d %s", uploaded.Code, uploaded.Body.String())
	}
	after := fixture.request(http.MethodGet, "/api/v1/books/101/cover", nil, fixture.admin,
		map[string]string{"If-None-Match": before.Header().Get("ETag")})
	if after.Code != http.StatusOK || after.Header().Get("ETag") == before.Header().Get("ETag") {
		t.Fatalf("replaced cover = %d %v", after.Code, after.Header())
	}
	requireProblem(t, fixture.request(http.MethodPut, "/api/v1/books/101/cover", strings.NewReader("bad"),
		fixture.admin, map[string]string{"Content-Type": "image/png"}), http.StatusBadRequest)
	requireProblem(t, fixture.request(http.MethodPut, "/api/v1/books/101/cover", bytes.NewReader(imageBytes),
		fixture.reader, map[string]string{"Content-Type": "image/png"}), http.StatusForbidden)
	largeRequest := httptest.NewRequest(http.MethodPut, "/api/v1/books/101/cover", strings.NewReader("x"))
	largeRequest.ContentLength = covers.MaxInputBytes + 1
	largeRequest.Header.Set("Content-Type", "image/png")
	largeRequest.AddCookie(fixture.admin)
	largeResponse := httptest.NewRecorder()
	fixture.router.ServeHTTP(largeResponse, largeRequest)
	requireProblem(t, largeResponse, http.StatusRequestEntityTooLarge)
	chunkedRequest := httptest.NewRequest(http.MethodPut, "/api/v1/books/101/cover",
		bytes.NewReader(make([]byte, covers.MaxInputBytes+1)))
	chunkedRequest.ContentLength = -1
	chunkedRequest.Header.Set("Content-Type", "image/png")
	chunkedRequest.AddCookie(fixture.admin)
	chunkedResponse := httptest.NewRecorder()
	fixture.router.ServeHTTP(chunkedResponse, chunkedRequest)
	requireProblem(t, chunkedResponse, http.StatusRequestEntityTooLarge)
}

func TestCatalogHTTPVisibilityChangesAndWriteProtection(t *testing.T) {
	fixture := newCatalogHTTPFixture(t)
	fileURL := "/api/v1/books/101/files/201"
	coverURL := "/api/v1/books/101/cover"
	initialFile := fixture.request(http.MethodGet, fileURL, nil, fixture.reader, nil)
	initialCover := fixture.request(http.MethodGet, coverURL, nil, fixture.reader, nil)
	hideURL := "/api/v1/admin/users/2/hidden-books/101"
	for range 2 {
		response := fixture.request(http.MethodPut, hideURL, nil, fixture.admin, nil)
		if response.Code != http.StatusOK {
			t.Fatalf("hide = %d %s", response.Code, response.Body.String())
		}
	}
	for _, test := range []struct {
		target string
		etag   string
	}{
		{fileURL, initialFile.Header().Get("ETag")},
		{coverURL, initialCover.Header().Get("ETag")},
	} {
		requireProblem(t, fixture.request(http.MethodGet, test.target, nil, fixture.reader,
			map[string]string{"If-None-Match": test.etag}), http.StatusNotFound)
	}
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/authors/1", nil, fixture.reader, nil), http.StatusNotFound)
	if response := fixture.request(http.MethodDelete, hideURL, nil, fixture.admin, nil); response.Code != http.StatusOK {
		t.Fatalf("unhide = %d %s", response.Code, response.Body.String())
	}
	grantURL := "/api/v1/admin/libraries/10/access/2"
	if response := fixture.request(http.MethodDelete, grantURL, nil, fixture.admin, nil); response.Code != http.StatusOK {
		t.Fatalf("revoke = %d %s", response.Code, response.Body.String())
	}
	requireProblem(t, fixture.request(http.MethodGet, fileURL, nil, fixture.reader,
		map[string]string{"If-None-Match": initialFile.Header().Get("ETag")}), http.StatusNotFound)
	if response := fixture.request(http.MethodPut, grantURL, nil, fixture.admin, nil); response.Code != http.StatusOK {
		t.Fatalf("grant = %d %s", response.Code, response.Body.String())
	}
	if response := fixture.request(http.MethodGet, fileURL, nil, fixture.reader, nil); response.Code != http.StatusOK {
		t.Fatalf("restored file = %d %s", response.Code, response.Body.String())
	}
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/books/103", nil, fixture.admin, nil), http.StatusNotFound)
	if response := fixture.request(http.MethodDelete, "/api/v1/admin/users/1/hidden-books/103", nil, fixture.admin, nil); response.Code != http.StatusOK {
		t.Fatalf("unhide admin = %d %s", response.Code, response.Body.String())
	}
	if response := fixture.request(http.MethodGet, "/api/v1/books/103", nil, fixture.admin, nil); response.Code != http.StatusOK {
		t.Fatalf("admin book after unhide = %d %s", response.Code, response.Body.String())
	}
	for _, test := range []struct {
		method string
		target string
	}{
		{http.MethodPost, "/api/v1/admin/libraries"},
		{http.MethodPatch, "/api/v1/admin/libraries/10"},
		{http.MethodDelete, "/api/v1/admin/libraries/30"},
		{http.MethodPut, grantURL},
		{http.MethodDelete, grantURL},
		{http.MethodPut, hideURL},
		{http.MethodDelete, hideURL},
		{http.MethodPatch, "/api/v1/books/101"},
		{http.MethodDelete, "/api/v1/books/101"},
		{http.MethodPut, coverURL},
	} {
		requireProblem(t, fixture.request(test.method, test.target, nil, fixture.reader, nil), http.StatusForbidden)
		requireProblem(t, fixture.request(test.method, test.target, nil, fixture.admin,
			map[string]string{"Sec-Fetch-Site": "cross-site"}), http.StatusForbidden)
	}
}

func TestMutableMediaDoesNotReturnStaleDateOnlyResponses(t *testing.T) {
	fixture := newCatalogHTTPFixture(t)
	fileURL := "/api/v1/books/101/files/201"
	future := time.Unix(200, 0).UTC().Format(http.TimeFormat)
	file := fixture.request(http.MethodGet, fileURL, nil, fixture.reader, map[string]string{"If-Modified-Since": future})
	if file.Code != http.StatusOK {
		t.Fatalf("unversioned file with date validator = %d, want 200", file.Code)
	}

	const previousMillis = int64(1700000000000)
	if _, err := fixture.db.Writer.ExecContext(context.Background(), `UPDATE books SET updated_at = ? WHERE id = 101`, previousMillis); err != nil {
		t.Fatal(err)
	}
	coverURL := "/api/v1/books/101/cover"
	before := fixture.request(http.MethodGet, coverURL, nil, fixture.admin, nil)
	imageBytes := testPNG(t, color.RGBA{R: 10, G: 140, B: 100, A: 255})
	uploaded := fixture.request(http.MethodPut, coverURL, bytes.NewReader(imageBytes), fixture.admin,
		map[string]string{"Content-Type": "image/png"})
	if uploaded.Code != http.StatusOK {
		t.Fatalf("cover update = %d %s", uploaded.Code, uploaded.Body.String())
	}
	if _, err := fixture.db.Writer.ExecContext(context.Background(), `UPDATE books SET updated_at = ? WHERE id = 101`, previousMillis+1); err != nil {
		t.Fatal(err)
	}
	validator := time.UnixMilli(previousMillis).UTC().Format(http.TimeFormat)
	after := fixture.request(http.MethodGet, coverURL, nil, fixture.admin, map[string]string{"If-Modified-Since": validator})
	if after.Code != http.StatusOK || before.Header().Get("ETag") == after.Header().Get("ETag") {
		t.Fatalf("replaced cover with date validator = %d, before %q after %q",
			after.Code, before.Header().Get("ETag"), after.Header().Get("ETag"))
	}
}

func TestCatalogHTTPPaginationAndDelete(t *testing.T) {
	fixture := newCatalogHTTPFixture(t)
	first := fixture.request(http.MethodGet, "/api/v1/books?limit=1", nil, fixture.admin, nil)
	var page catalog.Page[catalog.Book]
	if first.Code != http.StatusOK {
		t.Fatalf("first page = %d %s", first.Code, first.Body.String())
	}
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil || len(page.Items) != 1 || page.NextCursor == nil {
		t.Fatalf("first page = %+v, %v", page, err)
	}
	cursor := *page.NextCursor
	second := fixture.request(http.MethodGet, "/api/v1/books?limit=1&cursor="+cursor, nil, fixture.admin, nil)
	if err := json.Unmarshal(second.Body.Bytes(), &page); err != nil || second.Code != http.StatusOK ||
		len(page.Items) != 1 || page.NextCursor != nil {
		t.Fatalf("second page = %d %+v, %v", second.Code, page, err)
	}
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/books?sort=added&cursor="+cursor, nil, fixture.admin, nil), http.StatusBadRequest)
	for _, target := range []string{
		"/api/v1/books?limit=101", "/api/v1/books?sort=series", "/api/v1/books?author_id=-1",
		"/api/v1/books?limit=1&limit=2", "/api/v1/books?unknown=x", "/api/v1/books?cursor=",
	} {
		requireProblem(t, fixture.request(http.MethodGet, target, nil, fixture.admin, nil), http.StatusBadRequest)
	}
	deleted := fixture.request(http.MethodDelete, "/api/v1/books/101", nil, fixture.admin, nil)
	if deleted.Code != http.StatusOK || !strings.Contains(deleted.Body.String(), `"deleted":true`) {
		t.Fatalf("delete book = %d %s", deleted.Code, deleted.Body.String())
	}
	requireProblem(t, fixture.request(http.MethodGet, "/api/v1/books/101", nil, fixture.reader, nil), http.StatusNotFound)
}
