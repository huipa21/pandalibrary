package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pandalibrary/internal/auth"
)

func TestOPDSRouteIsMountedInApplication(t *testing.T) {
	ctx := context.Background()
	application, err := newApplication(ctx, testConfig(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := application.close(); err != nil {
			t.Error(err)
		}
	})
	response := httptest.NewRecorder()
	application.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/opds", nil))
	if response.Code != http.StatusUnauthorized || !strings.HasPrefix(response.Header().Get("WWW-Authenticate"), "Basic ") {
		t.Fatalf("OPDS route = %d %v, want Basic challenge", response.Code, response.Header())
	}

	if _, err := application.databases.Writer.ExecContext(ctx, `INSERT INTO users
		(id, username, password_hash, role, created_at, updated_at) VALUES (1, 'reader', 'x', 'user', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	authentication, err := auth.NewService(ctx, application.databases.Writer, application.databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	password, err := authentication.CreateAppPassword(ctx, 1, "opds", "reader app")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/opds", nil)
	request.SetBasicAuth("reader", password.Secret)
	response = httptest.NewRecorder()
	application.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.HasPrefix(response.Header().Get("Content-Type"), "application/atom+xml;profile=opds-catalog;kind=navigation") {
		t.Fatalf("authenticated OPDS root = %d %v %s", response.Code, response.Header(), response.Body.String())
	}
}
