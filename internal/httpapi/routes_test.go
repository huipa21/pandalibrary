package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"

	"github.com/go-chi/chi/v5"

	"pandalibrary/internal/db"
)

func testRouter(t *testing.T, mounts ...Mount) (http.Handler, *db.DB, *atomic.Bool, *bytes.Buffer) {
	t.Helper()
	databases, err := db.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close databases: %v", err)
		}
	})
	assets := fstest.MapFS{
		"index.html":                   &fstest.MapFile{Data: []byte(`<!doctype html><!-- <script>ignored</script> --><script type="module">start()</script>`)},
		"_app/immutable/entry/main.js": &fstest.MapFile{Data: []byte(`export const value = 1;`)},
		"robots.txt":                   &fstest.MapFile{Data: []byte("User-agent: *\n")},
	}
	var ready atomic.Bool
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	baseURL, err := url.Parse("https://public.example")
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewRouter(RouterOptions{
		Database: databases.Reader, Ready: ready.Load, Assets: assets, Logger: logger,
		TrustedProxies: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")},
		MaxBodyBytes:   8, BaseURL: baseURL, Mounts: mounts,
	})
	if err != nil {
		t.Fatal(err)
	}
	return router, databases, &ready, &logs
}

func perform(router http.Handler, method, target string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(method, target, nil))
	return response
}

func requireProblem(t *testing.T, response *httptest.ResponseRecorder, status int) {
	t.Helper()
	if response.Code != status || response.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("response = %d %q %q, want problem %d", response.Code,
			response.Header().Get("Content-Type"), response.Body.String(), status)
	}
	var body problem
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Status != status ||
		body.Type != "about:blank" || body.Title == "" {
		t.Fatalf("invalid problem response: %+v, %v", body, err)
	}
}

func TestHealthReadinessAndDatabaseFailure(t *testing.T) {
	router, databases, ready, _ := testRouter(t)
	methodError := perform(router, http.MethodPost, "/healthz")
	requireProblem(t, methodError, http.StatusMethodNotAllowed)
	if methodError.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("health method Allow = %q", methodError.Header().Get("Allow"))
	}
	requireProblem(t, perform(router, http.MethodGet, "/healthz"), http.StatusServiceUnavailable)
	ready.Store(true)
	response := perform(router, http.MethodGet, "/healthz")
	if response.Code != http.StatusOK || response.Body.String() != "ok\n" {
		t.Fatalf("health response = %d %q", response.Code, response.Body.String())
	}
	if err := databases.Reader.Close(); err != nil {
		t.Fatal(err)
	}
	response = perform(router, http.MethodGet, "/healthz")
	requireProblem(t, response, http.StatusServiceUnavailable)
	if strings.Contains(response.Body.String(), "database") {
		t.Fatalf("health response exposed an internal error: %s", response.Body.String())
	}
}

func TestSPAAndReservedPaths(t *testing.T) {
	router, _, _, _ := testRouter(t)
	noncePattern := regexp.MustCompile(`'nonce-([A-Za-z0-9+/=]+)'`)
	var previousNonce string
	for _, path := range []string{"/", "/books/42", "/books/42/", "/zh/", "/index.html"} {
		response := perform(router, http.MethodGet, path)
		if response.Code != http.StatusOK || !strings.Contains(response.Header().Get("Content-Type"), "text/html") ||
			response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %#v", path, response.Code, response.Header())
		}
		matches := noncePattern.FindStringSubmatch(response.Header().Get("Content-Security-Policy"))
		if len(matches) != 2 || matches[1] == previousNonce ||
			!strings.Contains(response.Body.String(), `nonce="`+matches[1]+`"`) ||
			!strings.Contains(response.Body.String(), `<!-- <script>ignored</script> -->`) {
			t.Fatalf("%s: CSP nonce did not match script: %q, %q", path,
				response.Header().Get("Content-Security-Policy"), response.Body.String())
		}
		previousNonce = matches[1]
	}
	head := perform(router, http.MethodHead, "/books/42")
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("HEAD fallback = %d %q", head.Code, head.Body.String())
	}
	asset := perform(router, http.MethodGet, "/_app/immutable/entry/main.js")
	if asset.Code != http.StatusOK || !strings.Contains(asset.Header().Get("Content-Type"), "javascript") ||
		asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset = %d %#v %q", asset.Code, asset.Header(), asset.Body.String())
	}
	for _, path := range []string{"/api", "/api/v1/missing", "/opds", "/kosync/missing", "/_app/", "/_app/immutable/", "/_app/immutable/missing.js"} {
		response := perform(router, http.MethodGet, path)
		requireProblem(t, response, http.StatusNotFound)
		if strings.Contains(response.Header().Get("Cache-Control"), "immutable") {
			t.Fatalf("missing asset was cached as immutable: %s", path)
		}
	}
	requireProblem(t, perform(router, http.MethodPost, "/books/42"), http.StatusMethodNotAllowed)
}

func TestMiddlewareAndTrustedProxies(t *testing.T) {
	mount := func(router chi.Router, _ Middleware) {
		router.Get("/api/v1/inspect", func(w http.ResponseWriter, r *http.Request) {
			if err := json.NewEncoder(w).Encode(map[string]string{
				"client": ClientIP(r), "scheme": RequestScheme(r), "id": RequestID(r),
				"forwarded": r.Header.Get("X-Forwarded-For"),
			}); err != nil {
				t.Error(err)
			}
		})
	}
	router, _, _, logs := testRouter(t, mount)
	tests := []struct {
		peer, forwarded, proto, wantIP, wantScheme string
	}{
		{"192.0.2.5:1234", "203.0.113.1", "https", "192.0.2.5", "http"},
		{"10.0.0.2:1234", "203.0.113.1, 198.51.100.7, 10.0.0.3", "https", "198.51.100.7", "https"},
		{"10.0.0.2:1234", "invalid", "https,http", "10.0.0.2", "http"},
	}
	for _, test := range tests {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/inspect?secret=query-value", nil)
		request.RemoteAddr = test.peer
		request.Header.Set("X-Forwarded-For", test.forwarded)
		request.Header.Set("X-Forwarded-Proto", test.proto)
		request.Header.Set("Authorization", "Bearer secret-token")
		request.Header.Set("Cookie", "session=secret-cookie")
		request.Header.Set("X-Request-ID", "untrusted-id")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		var got map[string]string
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || got["client"] != test.wantIP || got["scheme"] != test.wantScheme ||
			got["id"] == "" || got["id"] == "untrusted-id" || got["id"] != response.Header().Get("X-Request-ID") ||
			got["forwarded"] != "" {
			t.Fatalf("proxy case %+v: response %d %+v", test, response.Code, got)
		}
		if response.Header().Get("X-Content-Type-Options") != "nosniff" ||
			!strings.Contains(response.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatalf("missing security headers: %#v", response.Header())
		}
	}
	for _, secret := range []string{"query-value", "secret-token", "secret-cookie"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("logs exposed %q: %s", secret, logs.String())
		}
	}
}

func TestRecoveryBodyLimitAndCookieProtection(t *testing.T) {
	mount := func(router chi.Router, cookieProtection Middleware) {
		router.Get("/api/v1/panic", func(http.ResponseWriter, *http.Request) {
			panic("private panic")
		})
		router.Get("/api/v1/partial", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("partial"))
			panic("after headers")
		})
		router.Post("/api/v1/body", func(w http.ResponseWriter, r *http.Request) {
			if _, err := io.ReadAll(r.Body); err != nil {
				var limitError *http.MaxBytesError
				if errors.As(err, &limitError) {
					WriteProblem(w, slog.Default(), http.StatusRequestEntityTooLarge, "")
					return
				}
				t.Errorf("read body: %v", err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
		router.With(cookieProtection).Post("/api/v1/cookie", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})
	}
	router, _, _, logs := testRouter(t, mount)
	response := perform(router, http.MethodGet, "/api/v1/panic")
	requireProblem(t, response, http.StatusInternalServerError)
	if strings.Contains(response.Body.String(), "private panic") || strings.Contains(logs.String(), "private panic") ||
		!strings.Contains(logs.String(), "HTTP handler panic") {
		t.Fatal("panic details were not properly separated between response and log")
	}
	response = perform(router, http.MethodGet, "/api/v1/partial")
	if response.Code != http.StatusOK || response.Body.String() != "partial" {
		t.Fatalf("recovery wrote a second response: %d %q", response.Code, response.Body.String())
	}
	for _, length := range []int64{9, -1} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/body", strings.NewReader("123456789"))
		request.ContentLength = length
		response = httptest.NewRecorder()
		router.ServeHTTP(response, request)
		requireProblem(t, response, http.StatusRequestEntityTooLarge)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/cookie", nil)
	request.Header.Set("Origin", "https://evil.example")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	requireProblem(t, response, http.StatusForbidden)
	request = httptest.NewRequest(http.MethodPost, "/api/v1/cookie", nil)
	request.Header.Set("Origin", "https://public.example")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("trusted origin response = %d %q", response.Code, response.Body.String())
	}
}

func TestRejectExistingSPAScriptNonce(t *testing.T) {
	if _, err := splitIndexForNonces([]byte(`<script nonce="old">start()</script>`)); err == nil {
		t.Fatal("preexisting nonce accepted")
	}
}
