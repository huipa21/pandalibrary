package app

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDictionaryRoutesAreMountedInApplication(t *testing.T) {
	application, err := newApplication(context.Background(), testConfig(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := application.close(); err != nil {
			t.Error(err)
		}
	})
	for _, target := range []string{"/api/v1/dictionary/status", "/api/v1/dictionary/lookup?q=cat&from=en&to=zh"} {
		response := httptest.NewRecorder()
		application.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s = %d %s, want authenticated API route", target, response.Code, response.Body.String())
		}
	}

	ctx := context.Background()
	if _, err := application.databases.Writer.ExecContext(ctx, `
		INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		VALUES (1, 'reader', 'x', 'user', 1, 1)`); err != nil {
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
	request := httptest.NewRequest(http.MethodGet, "/api/v1/dictionary/status", nil)
	request.AddCookie(&http.Cookie{Name: "pl_session", Value: token})
	response := httptest.NewRecorder()
	application.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK ||
		strings.TrimSpace(response.Body.String()) != `{"directions":[],"sources":[]}` {
		t.Fatalf("authenticated status without dictionaries = %d %s", response.Code, response.Body.String())
	}
}
