package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/auth"
	notesexport "pandalibrary/internal/export"

	"github.com/go-chi/chi/v5"
)

func TestNotesExportHTTPAuthenticationSelectionAndAttachments(t *testing.T) {
	ctx := context.Background()
	databases := openHTTPTestDatabase(t)
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1), (2, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1)`,
		`INSERT INTO authors (id, name, sort_name, created_at) VALUES (1, '刘慈欣', '刘慈欣', 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(101, 10, '书 / One', 'one', 1, 1), (102, 10, 'Hidden', 'hidden', 1, 1),
			(103, 20, 'Private', 'private', 1, 1), (104, 10, '书 / Two', 'two', 1, 1)`,
		`INSERT INTO book_authors (book_id, author_id, role, position) VALUES
			(101, 1, 'author', 0), (104, 1, 'author', 0)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 102, 1, 1)`,
		`INSERT INTO notes (id, user_id, book_id, body_md, created_at, updated_at, rev) VALUES
			('00000000-0000-7000-8000-000000000101', 2, 101, 'Own note', 1, 1, 1)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed notes export HTTP fixture: %v", err)
		}
	}
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	tokenHash := sha256.Sum256([]byte(token))
	now := time.Now()
	if _, err := databases.Writer.ExecContext(ctx, `
		INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
		VALUES (?, 2, ?, ?, ?, '', '')`,
		tokenHash[:], now.UnixMilli(), now.Add(time.Hour).UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	authentication, err := auth.NewService(ctx, databases.Writer, databases.Reader, true)
	if err != nil {
		t.Fatal(err)
	}
	service, err := notesexport.NewService(databases.Writer, databases.Reader)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := chi.NewRouter()
	ExportMount(service, authentication, logger)(router, nil)
	cookie := &http.Cookie{Name: sessionCookieName, Value: token}

	if response := notesExportHTTPRequest(router, "/api/v1/me/notes/export?book_ids=101", nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated request = %d, want 401", response.Code)
	}
	for _, query := range []string{
		"", "?book_ids=", "?book_ids=101&book_ids=104", "?book_ids=101,101",
		"?book_ids=bad", "?book_ids=101,", "?book_ids=101&extra=1",
	} {
		response := notesExportHTTPRequest(router, "/api/v1/me/notes/export"+query, cookie)
		if response.Code != http.StatusBadRequest {
			t.Errorf("query %q returned %d, want 400: %s", query, response.Code, response.Body.String())
		}
	}
	tooMany := make([]string, 101)
	for index := range tooMany {
		tooMany[index] = strconv.Itoa(index + 1)
	}
	if response := notesExportHTTPRequest(router,
		"/api/v1/me/notes/export?book_ids="+strings.Join(tooMany, ","), cookie); response.Code != http.StatusBadRequest {
		t.Fatalf("over-limit request = %d, want 400", response.Code)
	}

	for _, ids := range []string{"102", "103", "101,102"} {
		response := notesExportHTTPRequest(router, "/api/v1/me/notes/export?book_ids="+ids, cookie)
		if response.Code != http.StatusNotFound {
			t.Errorf("inaccessible selection %q returned %d, want 404", ids, response.Code)
		}
	}

	single := notesExportHTTPRequest(router, "/api/v1/me/notes/export?book_ids=101", cookie)
	if single.Code != http.StatusOK || single.Header().Get("Content-Type") != "text/markdown; charset=utf-8" ||
		single.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("single export = %d headers %v", single.Code, single.Header())
	}
	disposition, parameters, err := mime.ParseMediaType(single.Header().Get("Content-Disposition"))
	if err != nil || disposition != "attachment" || parameters["filename"] != "书 _ One - 刘慈欣.md" {
		t.Fatalf("single attachment header = %q, parsed %q %v, error %v",
			single.Header().Get("Content-Disposition"), disposition, parameters, err)
	}
	if !strings.Contains(single.Body.String(), "Own note") {
		t.Fatalf("single Markdown body = %s", single.Body.String())
	}

	multiple := notesExportHTTPRequest(router, "/api/v1/me/notes/export?book_ids=101,104", cookie)
	if multiple.Code != http.StatusOK || multiple.Header().Get("Content-Type") != "application/zip" ||
		multiple.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("multiple export = %d headers %v", multiple.Code, multiple.Header())
	}
	_, zipParams, err := mime.ParseMediaType(multiple.Header().Get("Content-Disposition"))
	if err != nil || zipParams["filename"] != "PandaLibrary notes "+time.Now().UTC().Format("2006-01-02")+".zip" {
		t.Fatalf("ZIP attachment = %q (%v)", multiple.Header().Get("Content-Disposition"), err)
	}
	archive, err := zip.NewReader(bytes.NewReader(multiple.Body.Bytes()), int64(multiple.Body.Len()))
	if err != nil || len(archive.File) != 2 {
		t.Fatalf("multiple export ZIP = %v, error %v", archive, err)
	}
}

func notesExportHTTPRequest(handler http.Handler, path string, cookie *http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
