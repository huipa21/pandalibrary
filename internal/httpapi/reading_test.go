package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
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
	pushBody := `{"mutations":[{"entity":"user_books","key":"101","op":"upsert","data":{"book_id":101,"status":"unread"},"updated_at":100}]}`
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
	t.Run("reading statuses round-trip", func(t *testing.T) {
		var cursor int64
		for i, status := range []string{"unread", "want_to_read", "reading", "on_hold", "finished", "rereading", "skimmed", "abandoned"} {
			body := fmt.Sprintf(`{"mutations":[{"entity":"user_books","key":"101","op":"upsert","data":{"book_id":101,"status":%q,"rating":7,"started_at":10,"finished_at":null},"updated_at":%d}]}`, status, 101+i)
			response := readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push", body, cookie, "https://books.example")
			var pushed reading.PushResponse
			if err := json.Unmarshal(response.Body.Bytes(), &pushed); err != nil || response.Code != http.StatusOK ||
				len(pushed.Results) != 1 || pushed.Results[0].Status != "applied" {
				t.Fatalf("push %s = %d %s, %v", status, response.Code, response.Body.String(), err)
			}
			pull := readingHTTPRequest(t, router, http.MethodGet,
				fmt.Sprintf("/api/v1/sync/pull?cursor=%d", cursor), "", cookie, "")
			var pulled reading.PullResponse
			if err := json.Unmarshal(pull.Body.Bytes(), &pulled); err != nil || pull.Code != http.StatusOK ||
				len(pulled.UserBooks) != 1 || pulled.UserBooks[0].BookID != 101 || pulled.UserBooks[0].Status != status ||
				pulled.UserBooks[0].Rating == nil || *pulled.UserBooks[0].Rating != 7 ||
				pulled.Cursor <= cursor {
				t.Fatalf("pull %s = %d %s, %v", status, pull.Code, pull.Body.String(), err)
			}
			initial := status == "unread" || status == "want_to_read"
			terminal := status == "finished" || status == "skimmed" || status == "abandoned"
			if (pulled.UserBooks[0].StartedAt == nil) != initial ||
				(pulled.UserBooks[0].FinishedAt != nil) != terminal {
				t.Fatalf("lifecycle timestamps for %s = %+v", status, pulled.UserBooks[0])
			}
			summary := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/book-states?ids=101", "", cookie, "")
			if summary.Code != http.StatusOK || !strings.Contains(summary.Body.String(), fmt.Sprintf(`"status":%q`, status)) {
				t.Fatalf("book states %s = %d %s", status, summary.Code, summary.Body.String())
			}
			cursor = pulled.Cursor
		}
		body := `{"mutations":[{"entity":"user_books","key":"101","op":"upsert","data":{"book_id":101,"status":"invalid"},"updated_at":109}]}`
		response := readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push", body, cookie, "https://books.example")
		var rejected reading.PushResponse
		if err := json.Unmarshal(response.Body.Bytes(), &rejected); err != nil || response.Code != http.StatusOK ||
			len(rejected.Results) != 1 || rejected.Results[0].Status != "rejected" || rejected.Results[0].Reason != "status is invalid" {
			t.Fatalf("invalid status = %d %s, %v", response.Code, response.Body.String(), err)
		}
		for _, invalidTransition := range []string{"unread", "want_to_read", "on_hold"} {
			body := fmt.Sprintf(`{"mutations":[{"entity":"user_books","key":"101","op":"upsert","data":{"book_id":101,"status":%q},"updated_at":109}]}`, invalidTransition)
			response := readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push", body, cookie, "https://books.example")
			if err := json.Unmarshal(response.Body.Bytes(), &rejected); err != nil || response.Code != http.StatusOK ||
				len(rejected.Results) != 1 || rejected.Results[0].Status != "rejected" || rejected.Results[0].Reason == "" {
				t.Fatalf("invalid transition to %s = %d %s, %v", invalidTransition, response.Code, response.Body.String(), err)
			}
		}
	})
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

	t.Run("PDF annotations round-trip", func(t *testing.T) {
		body := `{"mutations":[` +
			`{"entity":"highlights","id":"018f0f7e-7b00-7000-8000-000000000004","op":"upsert",` +
			`"data":{"book_id":101,"book_file_id":201,"locator":{"type":"pdf","page":1},"position":0.2,"text":"passage","color":"orange","style":"underline"},"updated_at":1000},` +
			`{"entity":"page_annotations","id":"018f0f7e-7b00-7000-8000-000000000005","op":"upsert",` +
			`"data":{"book_id":101,"book_file_id":201,"kind":"text","locator":{"type":"pdf","page":1,"rect":{"x":0,"y":0,"width":0.5,"height":0.5}},` +
			`"position":0.2,"data":{"text":"Hello","color":"#000000","size":0.02}},"updated_at":1000}]}`
		response := readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push", body, cookie, "https://books.example")
		var pushed reading.PushResponse
		if err := json.Unmarshal(response.Body.Bytes(), &pushed); err != nil || response.Code != http.StatusOK ||
			len(pushed.Results) != 2 || pushed.Results[0].Status != "applied" || pushed.Results[1].Status != "applied" {
			t.Fatalf("annotation push = %d %s, %v", response.Code, response.Body.String(), err)
		}
		response = readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/books/101", "", cookie, "")
		var state reading.BookState
		if err := json.Unmarshal(response.Body.Bytes(), &state); err != nil || response.Code != http.StatusOK ||
			len(state.Highlights) != 1 || state.Highlights[0].Style != "underline" ||
			len(state.PageAnnotations) != 1 || state.PageAnnotations[0].Kind != "text" {
			t.Fatalf("annotation state = %d %s, %v", response.Code, response.Body.String(), err)
		}
		response = readingHTTPRequest(t, router, http.MethodGet, "/api/v1/sync/pull?cursor=0", "", cookie, "")
		var pulled reading.PullResponse
		if err := json.Unmarshal(response.Body.Bytes(), &pulled); err != nil || response.Code != http.StatusOK ||
			len(pulled.PageAnnotations) != 1 || len(pulled.Highlights) != 1 {
			t.Fatalf("annotation pull = %d %s, %v", response.Code, response.Body.String(), err)
		}
		deleteBody := `{"mutations":[{"entity":"page_annotations","id":"018f0f7e-7b00-7000-8000-000000000005","op":"delete","data":{},"updated_at":1100}]}`
		response = readingHTTPRequest(t, router, http.MethodPost, "/api/v1/sync/push", deleteBody, cookie, "https://books.example")
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"applied"`) {
			t.Fatalf("annotation delete = %d %s", response.Code, response.Body.String())
		}
		response = readingHTTPRequest(t, router, http.MethodGet, fmt.Sprintf("/api/v1/sync/pull?cursor=%d", pulled.Cursor), "", cookie, "")
		var incremental reading.PullResponse
		if err := json.Unmarshal(response.Body.Bytes(), &incremental); err != nil || response.Code != http.StatusOK ||
			len(incremental.PageAnnotations) != 1 || incremental.PageAnnotations[0].DeletedAt == nil {
			t.Fatalf("annotation tombstone = %d %s, %v", response.Code, response.Body.String(), err)
		}
	})

	states := readingHTTPRequest(t, router, http.MethodGet, "/api/v1/me/book-states?ids=101,102,999,101", "", cookie, "")
	if states.Code != http.StatusOK ||
		!strings.Contains(states.Body.String(), `"items":[{"book_id":101,"status":"abandoned","percentage":1,"book_file_id":null,"updated_at":"`) ||
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

	t.Run("sync account header", func(t *testing.T) {
		account := func(values ...string) http.Header {
			header := http.Header{}
			for _, value := range values {
				header.Add("X-PandaLibrary-Account", value)
			}
			return header
		}
		bookmarkBody := func(id string) string {
			return `{"mutations":[{"entity":"bookmarks","id":"` + id + `","op":"upsert","data":{"book_id":101,"book_file_id":201,"locator":{"type":"pdf","page":3},"position":0.6,"label":"Header"},"updated_at":200}]}`
		}
		const matchingID = "018f0f7e-7b00-7000-8000-000000000008"
		const mismatchedID = "018f0f7e-7b00-7000-8000-000000000009"

		response := readingHTTPRequestWithHeader(t, router, http.MethodPost, "/api/v1/sync/push",
			bookmarkBody(matchingID), cookie, "https://books.example", account("2"))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"applied"`) {
			t.Fatalf("matching account push = %d %s", response.Code, response.Body.String())
		}
		response = readingHTTPRequestWithHeader(t, router, http.MethodGet, "/api/v1/sync/pull?cursor=0", "", cookie, "", account("2"))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), matchingID) {
			t.Fatalf("matching account pull = %d %s", response.Code, response.Body.String())
		}

		response = readingHTTPRequestWithHeader(t, router, http.MethodPost, "/api/v1/sync/push",
			bookmarkBody(mismatchedID), cookie, "https://books.example", account("1"))
		if response.Code != http.StatusConflict ||
			response.Header().Get("Cache-Control") != "no-store" ||
			!strings.Contains(response.Body.String(), "The signed-in account changed.") {
			t.Fatalf("mismatched account push = %d %s", response.Code, response.Body.String())
		}
		response = readingHTTPRequestWithHeader(t, router, http.MethodGet, "/api/v1/sync/pull?cursor=0", "", cookie, "", account("1"))
		if response.Code != http.StatusConflict || strings.Contains(response.Body.String(), matchingID) {
			t.Fatalf("mismatched account pull = %d %s", response.Code, response.Body.String())
		}
		response = readingHTTPRequest(t, router, http.MethodGet, "/api/v1/sync/pull?cursor=0", "", cookie, "")
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), matchingID) ||
			strings.Contains(response.Body.String(), mismatchedID) {
			t.Fatalf("pull after mismatched push = %d %s", response.Code, response.Body.String())
		}

		for _, header := range []http.Header{
			account(""), account("0"), account("-1"), account("02"), account("+2"), account("2.0"),
			account(" 2"), account("abc"), account("9223372036854775808"), account("2", "2"),
		} {
			push := readingHTTPRequestWithHeader(t, router, http.MethodPost, "/api/v1/sync/push",
				bookmarkBody(mismatchedID), cookie, "https://books.example", header)
			pull := readingHTTPRequestWithHeader(t, router, http.MethodGet, "/api/v1/sync/pull?cursor=0", "", cookie, "", header)
			for name, response := range map[string]*httptest.ResponseRecorder{"push": push, "pull": pull} {
				if response.Code != http.StatusBadRequest ||
					response.Header().Get("Content-Type") != "application/problem+json" ||
					!strings.Contains(response.Body.String(), "The account header is invalid.") {
					t.Errorf("%s with account %q = %d %s", name, header.Values("X-PandaLibrary-Account"), response.Code, response.Body.String())
				}
			}
		}
		response = readingHTTPRequest(t, router, http.MethodGet, "/api/v1/sync/pull?cursor=0", "", cookie, "")
		if response.Code != http.StatusOK || strings.Contains(response.Body.String(), mismatchedID) {
			t.Fatalf("pull after invalid account pushes = %d %s", response.Code, response.Body.String())
		}
	})
}

func readingHTTPRequest(
	t *testing.T, handler http.Handler, method, path, body string, cookie *http.Cookie, origin string,
) *httptest.ResponseRecorder {
	t.Helper()
	return readingHTTPRequestWithHeader(t, handler, method, path, body, cookie, origin, nil)
}

func readingHTTPRequestWithHeader(
	t *testing.T, handler http.Handler, method, path, body string, cookie *http.Cookie, origin string, header http.Header,
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
	for name, values := range header {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
