package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"pandalibrary/internal/db"
	"pandalibrary/internal/search"
)

func TestSearchRouteIsMountedInApplication(t *testing.T) {
	application, err := newApplication(context.Background(), testConfig(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := application.close(); err != nil {
			t.Error(err)
		}
	})
	response := httptest.NewRecorder()
	application.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/search?q=test", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("search route = %d %s, want authenticated API route", response.Code, response.Body.String())
	}

	ctx := context.Background()
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
			VALUES (1, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (10, 'Main', 'main', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 1, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
			VALUES (101, 10, 'Searchable Book', 'searchable', 1, 1)`,
	} {
		if _, err := application.databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.WithTx(ctx, application.databases.Writer, func(tx *sql.Tx) error {
		return search.IndexBook(ctx, tx, 101)
	}); err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	hash := sha256.Sum256([]byte(token))
	now := time.Now()
	if _, err := application.databases.Writer.ExecContext(ctx, `
		INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
		VALUES (?, 1, ?, ?, ?)`, hash[:], now.UnixMilli(),
		now.Add(time.Hour).UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/search?q=searchable", nil)
	request.AddCookie(&http.Cookie{Name: "pl_session", Value: token})
	response = httptest.NewRecorder()
	application.handler.ServeHTTP(response, request)
	var page search.Page
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || len(page.Items) != 1 || page.Items[0].ID != 101 ||
		page.Items[0].Title != "Searchable Book" || page.NextCursor != nil {
		t.Fatalf("authenticated search = %d %+v", response.Code, page)
	}
}
