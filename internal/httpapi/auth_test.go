package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"

	"github.com/go-chi/chi/v5"
)

func TestAuthHTTPFlowAndCookieAttributes(t *testing.T) {
	ctx := context.Background()
	databases := openHTTPTestDatabase(t)
	service, err := auth.NewService(ctx, databases.Writer, databases.Reader, true)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := chi.NewRouter()
	mount := AuthMount(service, logger)
	cookieProtection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mount(router, cookieProtection)
	token := service.InitialSetupToken()
	setup := authRequest(t, router, http.MethodPost, "/api/v1/setup", map[string]string{
		"token": token, "username": "admin", "display_name": "Admin",
		"password": "correct horse battery", "locale": "en",
	}, nil)
	if setup.Code != http.StatusCreated {
		t.Fatalf("setup status = %d, body = %s", setup.Code, setup.Body.String())
	}
	cookies := setup.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("setup response cookies = %+v", cookies)
	}
	cookie := cookies[0]
	if cookie.Name != sessionCookieName || !cookie.HttpOnly || !cookie.Secure ||
		cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" {
		t.Fatalf("session cookie attributes = %+v", cookie)
	}

	me := authRequest(t, router, http.MethodGet, "/api/v1/auth/me", nil, cookie)
	if me.Code != http.StatusOK || strings.Contains(me.Body.String(), "password_hash") {
		t.Fatalf("authenticated me response = %d %s", me.Code, me.Body.String())
	}
	profile := authRequest(t, router, http.MethodPatch, "/api/v1/me/profile", map[string]string{
		"display_name": "New Name", "locale": "zh",
	}, cookie)
	if profile.Code != http.StatusOK || !strings.Contains(profile.Body.String(), "New Name") {
		t.Fatalf("profile update response = %d %s", profile.Code, profile.Body.String())
	}
	created := authRequest(t, router, http.MethodPost, "/api/v1/me/app-passwords", map[string]string{
		"kind": "opds", "label": "Device",
	}, cookie)
	if created.Code != http.StatusCreated || !strings.Contains(created.Body.String(), "secret") {
		t.Fatalf("app-password response = %d %s", created.Code, created.Body.String())
	}
	var response struct {
		AppPassword struct {
			ID int64 `json:"id"`
		} `json:"app_password"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	list := authRequest(t, router, http.MethodGet, "/api/v1/me/app-passwords", nil, cookie)
	if strings.Contains(list.Body.String(), "secret") || strings.Contains(list.Body.String(), "secret_hash") {
		t.Fatalf("app-password list exposed a secret: %s", list.Body.String())
	}
	revoke := authRequest(t, router, http.MethodDelete,
		"/api/v1/me/app-passwords/"+strconv.FormatInt(response.AppPassword.ID, 10), nil, cookie)
	if revoke.Code != http.StatusOK {
		t.Fatalf("revoke status = %d, body = %s", revoke.Code, revoke.Body.String())
	}
	logout := authRequest(t, router, http.MethodPost, "/api/v1/auth/logout", map[string]bool{}, cookie)
	if logout.Code != http.StatusOK {
		t.Fatalf("logout status = %d, body = %s", logout.Code, logout.Body.String())
	}
	unauthenticated := authRequest(t, router, http.MethodGet, "/api/v1/auth/me", nil, nil)
	if unauthenticated.Code != http.StatusUnauthorized ||
		!strings.Contains(unauthenticated.Header().Get("Content-Type"), "application/problem+json") {
		t.Fatalf("unauthenticated me response = %d %s", unauthenticated.Code, unauthenticated.Body.String())
	}
	login := authRequest(t, router, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "admin", "password": "correct horse battery",
	}, nil)
	if login.Code != http.StatusOK || len(login.Result().Cookies()) != 1 {
		t.Fatalf("login response = %d %s, cookies = %+v", login.Code, login.Body.String(), login.Result().Cookies())
	}
}

func TestAuthHTTPRejectsInvalidAndRateLimitedRequests(t *testing.T) {
	ctx := context.Background()
	databases := openHTTPTestDatabase(t)
	service, err := auth.NewService(ctx, databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := chi.NewRouter()
	mount := AuthMount(service, logger)
	cookieProtection, err := CookieProtection(nil, logger)
	if err != nil {
		t.Fatal(err)
	}
	mount(router, cookieProtection)

	invalid := authRequest(t, router, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "missing", "password": "correct horse battery",
	}, nil)
	if invalid.Code != http.StatusUnauthorized {
		t.Fatalf("invalid login status = %d, body = %s", invalid.Code, invalid.Body.String())
	}
	for range 4 {
		_ = authRequest(t, router, http.MethodPost, "/api/v1/auth/login", map[string]string{
			"username": "missing", "password": "correct horse battery",
		}, nil)
	}
	limited := authRequest(t, router, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "missing", "password": "correct horse battery",
	}, nil)
	if limited.Code != http.StatusTooManyRequests || limited.Header().Get("Retry-After") == "" {
		t.Fatalf("rate-limited login = %d, headers = %v", limited.Code, limited.Header())
	}
	unknownField := authRequest(t, router, http.MethodPost, "/api/v1/auth/login", map[string]string{
		"username": "missing", "password": "correct horse battery", "admin": "true",
	}, nil)
	if unknownField.Code != http.StatusTooManyRequests {
		t.Fatalf("unknown-field request should still be throttled, status = %d", unknownField.Code)
	}
	setupRequired := authRequest(t, router, http.MethodGet, "/api/v1/setup", nil, nil)
	if setupRequired.Code != http.StatusOK || !strings.Contains(setupRequired.Body.String(), `"required":true`) {
		t.Fatalf("setup status response = %d %s", setupRequired.Code, setupRequired.Body.String())
	}
	for range 5 {
		response := authRequest(t, router, http.MethodPost, "/api/v1/setup", map[string]string{
			"token": "invalid", "username": "admin", "password": "correct horse battery",
		}, nil)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("invalid setup token status = %d, body = %s", response.Code, response.Body.String())
		}
	}
	setupLimited := authRequest(t, router, http.MethodPost, "/api/v1/setup", map[string]string{
		"token": "invalid", "username": "admin", "password": "correct horse battery",
	}, nil)
	if setupLimited.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited setup status = %d, body = %s", setupLimited.Code, setupLimited.Body.String())
	}
}

func TestRequireRoleUsesAuthenticatedViewer(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := RequireRole("admin", logger)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	for _, test := range []struct {
		name string
		user *auth.User
		want int
	}{
		{name: "missing viewer", want: http.StatusUnauthorized},
		{name: "wrong role", user: &auth.User{ID: 2, Role: "user"}, want: http.StatusForbidden},
		{name: "administrator", user: &auth.User{ID: 1, Role: "admin"}, want: http.StatusNoContent},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/admin", nil)
			if test.user != nil {
				request = request.WithContext(context.WithValue(request.Context(), viewerContextKey{}, *test.user))
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("role response = %d, want %d", response.Code, test.want)
			}
		})
	}
}

func openHTTPTestDatabase(t *testing.T) *db.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pandalibrary.db")
	ctx := context.Background()
	databases, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close test database: %v", err)
		}
	})
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	return databases
}

func authRequest(t *testing.T, handler http.Handler, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		requestBody = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, requestBody)
	request.RemoteAddr = "192.0.2.10:54321"
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
