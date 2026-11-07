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
	"net/url"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/reading"

	"github.com/go-chi/chi/v5"
)

func TestReadingLogHTTPSummarySessionsAndDelete(t *testing.T) {
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
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 102, 1, 1)`,
	}
	for _, statement := range seed {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed HTTP fixture: %v", err)
		}
	}
	// Sessions run 15:32-16:30 UTC: one UTC date, but they cross midnight in Shanghai.
	base := time.Date(2026, 1, 1, 15, 30, 0, 0, time.UTC)
	for n := 1; n <= 30; n++ {
		started := base.Add(time.Duration(2*n) * time.Minute).UnixMilli()
		if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO reading_sessions
			(id, user_id, book_id, source, device, started_at, ended_at, active_seconds, start_percentage, end_percentage, created_at)
			VALUES (?, 2, 101, 'web', 'Browser', ?, ?, 60, ?, ?, 1)`,
			fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", n), started, started+60000,
			float64(n-1)/100, float64(n)/100); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO reading_sessions
		(id, user_id, book_id, source, device, started_at, ended_at, active_seconds, created_at)
		VALUES ('018f0f7e-7b00-7000-8000-000000000099', 1, 101, 'web', '', 1, 2, 60, 1)`); err != nil {
		t.Fatal(err)
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
	get := func(path string) *httptestResponse {
		return asResponse(readingHTTPRequest(t, router, http.MethodGet, path, "", cookie, ""))
	}

	summary := get("/api/v1/me/books/101/reading-summary?timezone=Asia%2FShanghai")
	var summaryBody struct {
		Summary reading.ReadingSummary `json:"summary"`
	}
	if summary.Code != http.StatusOK || summary.Header.Get("Cache-Control") != "no-store" ||
		json.Unmarshal(summary.Body, &summaryBody) != nil || summaryBody.Summary.Sessions != 30 ||
		summaryBody.Summary.TotalSeconds != 1800 || len(summaryBody.Summary.Days) != 2 ||
		len(summaryBody.Summary.Attempts) != 1 {
		t.Fatalf("summary = %d %s", summary.Code, summary.Body)
	}
	if utc := get("/api/v1/me/books/101/reading-summary"); utc.Code != http.StatusOK ||
		!strings.Contains(string(utc.Body), `"days":[{"date":"2026-01-01","seconds":1800,"sessions":30`) {
		t.Fatalf("default UTC summary = %d %s", utc.Code, utc.Body)
	}
	for _, query := range []string{"timezone=Mars%2FOlympus", "timezone=", "timezone=UTC&timezone=UTC", "unknown=1"} {
		if response := get("/api/v1/me/books/101/reading-summary?" + query); response.Code != http.StatusBadRequest ||
			response.Header.Get("Content-Type") != "application/problem+json" {
			t.Errorf("summary query %q = %d %s", query, response.Code, response.Body)
		}
	}

	seen := map[string]bool{}
	path := "/api/v1/me/books/101/sessions?limit=8&timezone=UTC"
	var pages int
	for {
		response := get(path)
		var page struct {
			Items []struct {
				ID      string   `json:"id"`
				Change  *float64 `json:"change"`
				Attempt int      `json:"attempt"`
			} `json:"items"`
			NextCursor *string `json:"next_cursor"`
			Total      int64   `json:"total"`
		}
		if response.Code != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" ||
			json.Unmarshal(response.Body, &page) != nil || page.Total != 30 {
			t.Fatalf("sessions page = %d %s", response.Code, response.Body)
		}
		pages++
		for _, item := range page.Items {
			if seen[item.ID] || item.Attempt != 1 || item.Change == nil {
				t.Fatalf("session item %+v (seen %v)", item, seen[item.ID])
			}
			seen[item.ID] = true
		}
		if pages == 1 && page.Items[0].ID != "018f0f7e-7b00-7000-8000-000000000030" {
			t.Fatalf("first session = %s", page.Items[0].ID)
		}
		if page.NextCursor == nil {
			break
		}
		if mismatch := get("/api/v1/me/books/101/sessions?range=30d&cursor=" + url.QueryEscape(*page.NextCursor)); mismatch.Code != http.StatusBadRequest {
			t.Fatalf("mismatched cursor = %d %s", mismatch.Code, mismatch.Body)
		}
		path = "/api/v1/me/books/101/sessions?limit=8&timezone=UTC&cursor=" + url.QueryEscape(*page.NextCursor)
	}
	if len(seen) != 30 || pages != 4 {
		t.Fatalf("paged %d sessions in %d pages", len(seen), pages)
	}
	for _, query := range []string{
		"range=week", "limit=0", "limit=101", "limit=1x", "cursor=", "cursor=bad", "timezone=Nope",
		"range=all&range=30d", "page=2",
	} {
		if response := get("/api/v1/me/books/101/sessions?" + query); response.Code != http.StatusBadRequest {
			t.Errorf("sessions query %q = %d %s", query, response.Code, response.Body)
		}
	}
	for _, path := range []string{
		"/api/v1/me/books/102/reading-summary", "/api/v1/me/books/999/reading-summary",
		"/api/v1/me/books/102/sessions", "/api/v1/me/books/999/sessions",
	} {
		if response := get(path); response.Code != http.StatusNotFound {
			t.Errorf("%s = %d %s", path, response.Code, response.Body)
		}
	}
	if response := get("/api/v1/me/books/0/sessions"); response.Code != http.StatusBadRequest {
		t.Errorf("zero book ID = %d", response.Code)
	}
	for _, path := range []string{"/api/v1/me/books/101/reading-summary", "/api/v1/me/books/101/sessions"} {
		if response := readingHTTPRequest(t, router, http.MethodGet, path, "", nil, ""); response.Code != http.StatusUnauthorized {
			t.Errorf("unauthenticated %s = %d", path, response.Code)
		}
	}

	deletePath := "/api/v1/me/books/101/sessions/018f0f7e-7b00-7000-8000-000000000001"
	if response := readingHTTPRequest(t, router, http.MethodDelete, deletePath, "", cookie, "https://attacker.example"); response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin delete = %d %s", response.Code, response.Body.String())
	}
	if response := readingHTTPRequest(t, router, http.MethodDelete, deletePath, "", nil, "https://books.example"); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated delete = %d", response.Code)
	}
	for path, want := range map[string]int{
		"/api/v1/me/books/101/sessions/018f0f7e-7b00-7000-8000-000000000099": http.StatusNotFound, // another user's
		"/api/v1/me/books/101/sessions/018f0f7e-7b00-7000-8000-000000000098": http.StatusNotFound, // missing
		"/api/v1/me/books/102/sessions/018f0f7e-7b00-7000-8000-000000000002": http.StatusNotFound, // invisible book
		"/api/v1/me/books/101/sessions/not-a-uuid":                           http.StatusBadRequest,
		"/api/v1/me/books/abc/sessions/018f0f7e-7b00-7000-8000-000000000002": http.StatusBadRequest,
	} {
		if response := readingHTTPRequest(t, router, http.MethodDelete, path, "", cookie, "https://books.example"); response.Code != want {
			t.Errorf("delete %s = %d %s, want %d", path, response.Code, response.Body.String(), want)
		}
	}
	deleted := readingHTTPRequest(t, router, http.MethodDelete, deletePath, "", cookie, "https://books.example")
	if deleted.Code != http.StatusNoContent || deleted.Body.Len() != 0 {
		t.Fatalf("delete = %d %s", deleted.Code, deleted.Body.String())
	}
	if again := readingHTTPRequest(t, router, http.MethodDelete, deletePath, "", cookie, "https://books.example"); again.Code != http.StatusNotFound {
		t.Fatalf("repeated delete = %d", again.Code)
	}
	if after := get("/api/v1/me/books/101/sessions?limit=1"); after.Code != http.StatusOK ||
		!strings.Contains(string(after.Body), `"total":29`) {
		t.Fatalf("sessions after delete = %d %s", after.Code, after.Body)
	}
}

type httptestResponse struct {
	Code   int
	Header http.Header
	Body   []byte
}

func asResponse(recorder interface {
	Result() *http.Response
}) *httptestResponse {
	result := recorder.Result()
	defer result.Body.Close()
	body, _ := io.ReadAll(result.Body)
	return &httptestResponse{Code: result.StatusCode, Header: result.Header, Body: body}
}
