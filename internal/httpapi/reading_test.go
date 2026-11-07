package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/reading"

	"github.com/go-chi/chi/v5"
)

func TestReadingHTTPAuthenticationVisibilitySyncAndSearch(t *testing.T) {
	ctx := context.Background()
	databases := openHTTPTestDatabase(t)
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	tokenHash := sha256.Sum256([]byte(token))
	seed := []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1), (2, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (10, 'Main', 'main', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(101, 10, 'Visible', 'visible', 1, 1), (102, 10, 'Hidden', 'hidden', 1, 1)`,
		`INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
			VALUES (201, 101, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'pdf', 1, 'book.pdf', 1)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 102, 1, 1)`,
	}
	for _, statement := range seed {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed HTTP fixture: %v", err)
		}
	}
	if _, err := databases.Writer.ExecContext(ctx, `
		INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
		VALUES (?, 2, ?, ?, ?, '', '')
	`, tokenHash[:], time.Now().UnixMilli(), time.Now().Add(time.Hour).UnixMilli(), time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	authentication, err := auth.NewService(ctx, databases.Writer, databases.Reader, true)
	if err != nil {
		t.Fatal(err)
	}
	service, err := reading.NewService(databases.Writer, databases.Reader)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cookieProtection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	ReadingMount(service, authentication, logger)(router, cookieProtection)
	cookie := &http.Cookie{Name: sessionCookieName, Value: token}

	visible := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/books/101", "", cookie, "")
	if visible.Code != http.StatusOK ||
		!strings.Contains(visible.Body.String(), `"user_book":null`) ||
		!strings.Contains(visible.Body.String(), `"highlights":[]`) {
		t.Fatalf("visible state = %d %s", visible.Code, visible.Body.String())
	}
	for _, id := range []string{"102", "999"} {
		response := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/books/"+id, "", cookie, "")
		if response.Code != http.StatusNotFound {
			t.Errorf("book %s state = %d %s, want 404", id, response.Code, response.Body.String())
		}
	}
	unauthenticated := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/settings", "", nil, "")
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated settings = %d", unauthenticated.Code)
	}
	badCursor := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/sync/pull?cursor=-1", "", cookie, "")
	if badCursor.Code != http.StatusBadRequest {
		t.Fatalf("negative cursor = %d %s", badCursor.Code, badCursor.Body.String())
	}
	validCursor := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/sync/pull?cursor=0", "", cookie, "")
	if validCursor.Code != http.StatusOK || !strings.Contains(validCursor.Body.String(), `"user_settings":[]`) {
		t.Fatalf("initial pull = %d %s", validCursor.Code, validCursor.Body.String())
	}
	pushBody := `{"mutations":[{"entity":"user_books","key":"101","op":"upsert","data":{"book_id":101,"status":"reading"},"updated_at":100}]}`
	push := readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push", pushBody, cookie, "https://books.example")
	if push.Code != http.StatusOK || !strings.Contains(push.Body.String(), `"status":"applied"`) {
		t.Fatalf("push = %d %s", push.Code, push.Body.String())
	}
	crossOrigin := readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push", pushBody, cookie, "https://attacker.example")
	if crossOrigin.Code != http.StatusForbidden {
		t.Fatalf("cross-origin push = %d %s", crossOrigin.Code, crossOrigin.Body.String())
	}
	badPayload := readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push",
		`{"mutations":[],"unexpected":true}`, cookie, "https://books.example")
	if badPayload.Code != http.StatusBadRequest {
		t.Fatalf("unknown request field = %d %s", badPayload.Code, badPayload.Body.String())
	}
	missingTimestamp := readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push",
		`{"mutations":[{"entity":"user_books","key":"101","op":"upsert","data":{"book_id":101,"status":"reading"}}]}`,
		cookie, "https://books.example")
	if missingTimestamp.Code != http.StatusBadRequest {
		t.Fatalf("missing mutation timestamp = %d %s", missingTimestamp.Code, missingTimestamp.Body.String())
	}
	bookmarkPush := `{"mutations":[{"entity":"bookmarks","id":"018f0f7e-7b00-7000-8000-000000000001","op":"upsert","data":{"book_id":101,"book_file_id":201,"locator":{"type":"pdf","page":2},"position":0.5,"label":"Here"},"updated_at":100}]}`
	bookmark := readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push", bookmarkPush, cookie, "https://books.example")
	if bookmark.Code != http.StatusOK || !strings.Contains(bookmark.Body.String(), `"status":"applied"`) {
		t.Fatalf("bookmark push = %d %s", bookmark.Code, bookmark.Body.String())
	}
	list := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/bookmarks?book_id=101&limit=1", "", cookie, "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"title":"Visible"`) ||
		!strings.Contains(list.Body.String(), `"type":"pdf"`) || !strings.Contains(list.Body.String(), `"next_cursor":null`) {
		t.Fatalf("bookmark list = %d %s", list.Code, list.Body.String())
	}
	for _, query := range []string{"limit=0", "limit=101", "book_id=0", "cursor=bad", "cursor=", "book_id=101&book_id=102", "unknown=1"} {
		response := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/bookmarks?"+query, "", cookie, "")
		if response.Code != http.StatusBadRequest {
			t.Errorf("bookmark query %q = %d %s", query, response.Code, response.Body.String())
		}
	}
	if response := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/bookmarks", "", nil, ""); response.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated bookmarks = %d", response.Code)
	}

	states := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/book-states?ids=101,102,999,101", "", cookie, "")
	if states.Code != http.StatusOK ||
		!strings.Contains(states.Body.String(), `"items":[{"book_id":101,"status":"reading","percentage":null,"book_file_id":null,"updated_at":"`) ||
		strings.Count(states.Body.String(), `"book_id"`) != 1 {
		t.Fatalf("book states = %d %s", states.Code, states.Body.String())
	}
	empty := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/book-states?ids=999", "", cookie, "")
	if empty.Code != http.StatusOK || !strings.Contains(empty.Body.String(), `"items":[]`) {
		t.Fatalf("empty book states = %d %s", empty.Code, empty.Body.String())
	}
	maxIDs := make([]string, reading.MaxBookStateIDs)
	for i := range maxIDs {
		maxIDs[i] = "101"
	}
	if response := readingHTTPRequest(t, router, http.MethodGet,
		"/api/v1/me/book-states?ids="+strings.Join(maxIDs, ","), "", cookie, ""); response.Code != http.StatusOK {
		t.Errorf("book states at the limit = %d %s", response.Code, response.Body.String())
	}
	for _, query := range []string{
		"", "ids=", "ids=0", "ids=-1", "ids=abc", "ids=1.5", "ids=01", "ids=1,,2", "ids=1,", "ids=+1",
		"ids=" + strings.Join(append(maxIDs, "102"), ","), "ids=1&ids=2", "ids=1&other=2",
	} {
		response := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/book-states?"+query, "", cookie, "")
		if response.Code != http.StatusBadRequest ||
			response.Header().Get("Content-Type") != "application/problem+json" {
			t.Errorf("book states query %q = %d %s", query, response.Code, response.Body.String())
		}
	}
	if response := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/book-states?ids=101", "", nil, ""); response.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated book states = %d", response.Code)
	}
}

func readingHTTPRequest(
	t *testing.T, handler http.Handler, method, path, body string, cookie *http.Cookie, origin string,
) *httptest.ResponseRecorder {
	t.Helper()
	var requestBody io.Reader
	if body != "" {
		requestBody = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, requestBody)
	request.RemoteAddr = "192.0.2.10:54321"
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
