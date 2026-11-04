package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/catalog"
)

func TestApplicationMountsShelfRoutes(t *testing.T) {
	app, err := newApplication(context.Background(), testConfig(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := app.close(); err != nil {
			t.Error(err)
		}
	})
	response := httptest.NewRecorder()
	app.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/shelves", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated shelf route = %d %s", response.Code, response.Body.String())
	}
	ctx := context.Background()
	if _, err := app.databases.Writer.ExecContext(ctx, `
		INSERT INTO users (id, username, display_name, password_hash, role, locale, created_at, updated_at)
		VALUES (1, 'reader', 'Reader', 'test', 'user', 'en', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	token := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	hash := sha256.Sum256([]byte(token))
	now := time.Now()
	if _, err := app.databases.Writer.ExecContext(ctx, `
		INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
		VALUES (?, 1, ?, ?, ?)`, hash[:], now.UnixMilli(), now.Add(time.Hour).UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	cookie := &http.Cookie{Name: "pl_session", Value: token}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/shelves",
		strings.NewReader(`{"kind":"private","name":"Real application"}`))
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	app.handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create shelf through application = %d %s", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodGet, "/api/v1/shelves", nil)
	request.AddCookie(cookie)
	response = httptest.NewRecorder()
	app.handler.ServeHTTP(response, request)
	var page catalog.Page[catalog.Shelf]
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != http.StatusOK ||
		len(page.Items) != 2 || page.Items[0].SystemKey == nil || page.Items[1].Name != "Real application" {
		t.Fatalf("list shelves through application = %d %+v, %v", response.Code, page, err)
	}
}
