package dictionary

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

var administrator = catalog.Viewer{UserID: 1, IsAdmin: true}

func newTestService(t *testing.T) *Service {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "dictionary.db")
	database, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	runner, err := migrations.NewRunner(database.Writer, path, migrations.Files(), migrations.Options{AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	return NewService(database.Writer, database.Reader, nil)
}

func configure(t *testing.T, service *Service, base string, key *string) Settings {
	t.Helper()
	patch := SettingsPatch{BaseURL: catalog.Optional[string]{Set: true, Value: &base}}
	if key != nil {
		patch.APIKey = catalog.Optional[string]{Set: true, Value: key}
	}
	settings, err := service.UpdateSettings(context.Background(), administrator, patch)
	if err != nil {
		t.Fatal(err)
	}
	return settings
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func TestServiceSendsBearerAndJoinsPaths(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret-key" || r.Header.Get("Accept") != "application/json" {
			t.Errorf("headers = %v", r.Header)
		}
		paths = append(paths, r.URL.Path+"?"+r.URL.RawQuery)
		switch r.URL.Path {
		case "/api/v2/status":
			writeJSON(w, http.StatusOK, map[string]any{
				"directions": []map[string]any{
					{"from": "en", "to": "zh", "sources": []string{"cedict"}},
					{"from": "en", "to": "fr", "sources": []string{"other"}},
				},
				"sources": []map[string]any{{"id": "cedict", "name": "CC-CEDICT"}},
			})
		case "/api/v2/lookup":
			writeJSON(w, http.StatusOK, map[string]any{"query": "run", "term": "run", "from": "en", "to": "zh",
				"entries": []map[string]any{{"source": "cedict", "sourceName": "CC-CEDICT", "headword": "run", "definitions": []string{"跑"}, "match": "exact"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	service := newTestService(t)
	key := "  secret-key  "
	settings := configure(t, service, " "+server.URL+"/api/v2/ ", &key)
	if settings.BaseURL == nil || *settings.BaseURL != server.URL+"/api/v2" || !settings.HasAPIKey {
		t.Fatalf("settings = %+v", settings)
	}
	data, _ := json.Marshal(settings)
	if strings.Contains(string(data), "secret") {
		t.Fatalf("settings leak the API key: %s", data)
	}

	status, err := service.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Directions) != 1 || status.Directions[0].To != Chinese || len(status.Sources) != 1 {
		t.Fatalf("status = %+v", status)
	}
	result, err := service.Lookup(context.Background(), Query{Text: " run ", From: English, To: Chinese})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 1 || result.Entries[0].Definitions[0] != "跑" {
		t.Fatalf("result = %+v", result)
	}
	want := []string{"/api/v2/status?", "/api/v2/lookup?from=en&limit=20&q=run&to=zh"}
	if strings.Join(paths, "|") != strings.Join(want, "|") {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
}

func TestServiceUnconfigured(t *testing.T) {
	service := newTestService(t)
	status, err := service.Status(context.Background())
	if err != nil || status.Directions == nil || status.Sources == nil || len(status.Directions) != 0 {
		t.Fatalf("status = %+v, %v", status, err)
	}
	if _, err := service.Lookup(context.Background(), Query{Text: "run", From: English, To: Chinese}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("lookup error = %v", err)
	}
	if _, err := service.TestConnection(context.Background(), administrator); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("test connection error = %v", err)
	}
	if _, err := service.Lookup(context.Background(), Query{Text: "  ", From: English, To: Chinese}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty lookup error = %v", err)
	}
	if _, err := service.Lookup(context.Background(), Query{Text: strings.Repeat("あ", MaxQueryRunes+1), From: Japanese, To: English}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("long lookup error = %v", err)
	}
}

func TestServiceMapsRemoteErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("q") == "bad" {
			w.Header().Set("Content-Type", "application/problem+json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"title":"Bad Request","detail":"Unsupported direction."}`))
			return
		}
		if r.URL.Query().Get("q") == "html" {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html></html>"))
			return
		}
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()
	service := newTestService(t)
	key := "do-not-leak"
	configure(t, service, server.URL, &key)

	_, err := service.Lookup(context.Background(), Query{Text: "bad", From: English, To: Japanese})
	if !errors.Is(err, ErrInvalid) || err.Error() != "invalid dictionary request: Unsupported direction." {
		t.Fatalf("400 error = %v", err)
	}
	for _, text := range []string{"boom", "html"} {
		_, err = service.Lookup(context.Background(), Query{Text: text, From: English, To: Japanese})
		if !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), key) {
			t.Fatalf("%s error = %v", text, err)
		}
	}
	if _, err := service.Status(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("status error = %v", err)
	}
}

func TestServiceSettingsValidation(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	str := func(value string) catalog.Optional[string] { return catalog.Optional[string]{Set: true, Value: &value} }
	user := catalog.Viewer{UserID: 2}
	if _, err := service.Settings(ctx, user); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatalf("settings error = %v", err)
	}
	if _, err := service.UpdateSettings(ctx, user, SettingsPatch{BaseURL: str("https://example.com")}); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatalf("update error = %v", err)
	}
	if _, err := service.TestConnection(ctx, user); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatalf("test error = %v", err)
	}
	invalid := []SettingsPatch{
		{},
		{BaseURL: str("ftp://example.com")},
		{BaseURL: str("example.com/api")},
		{BaseURL: str("https://user:pass@example.com")},
		{BaseURL: str("https://example.com/?q=1")},
		{BaseURL: str("https://example.com/#top")},
		{BaseURL: str("https://example.com/" + strings.Repeat("a", 2048))},
		{APIKey: str("   ")},
		{APIKey: str("a\nb")},
		{APIKey: str("a b")},
		{APIKey: str(strings.Repeat("k", 8193))},
		{APIKey: str("\xff")},
	}
	for _, patch := range invalid {
		if _, err := service.UpdateSettings(ctx, administrator, patch); !errors.Is(err, ErrInvalid) {
			t.Errorf("patch %+v error = %v", patch, err)
		}
	}
	settings, err := service.UpdateSettings(ctx, administrator, SettingsPatch{BaseURL: str("http://dict.local:8080/"), APIKey: str("key")})
	if err != nil || settings.BaseURL == nil || *settings.BaseURL != "http://dict.local:8080" || !settings.HasAPIKey {
		t.Fatalf("settings = %+v, %v", settings, err)
	}
	settings, err = service.UpdateSettings(ctx, administrator, SettingsPatch{BaseURL: str("  "), APIKey: catalog.Optional[string]{Set: true}})
	if err != nil || settings.BaseURL != nil || settings.HasAPIKey {
		t.Fatalf("cleared settings = %+v, %v", settings, err)
	}
	reloaded, err := service.Settings(ctx, administrator)
	if err != nil || reloaded.BaseURL != nil || reloaded.HasAPIKey {
		t.Fatalf("reloaded settings = %+v, %v", reloaded, err)
	}
}

func TestServiceStatusCacheInvalidatedOnUpdate(t *testing.T) {
	var calls atomic.Int32
	newServer := func(to string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			writeJSON(w, http.StatusOK, Status{Directions: []Direction{{From: English, To: Lang(to), Sources: []string{"s"}}}})
		}))
	}
	first, second := newServer("zh"), newServer("ja")
	defer first.Close()
	defer second.Close()
	service := newTestService(t)
	configure(t, service, first.URL, nil)
	for range 2 {
		status, err := service.Status(context.Background())
		if err != nil || status.Directions[0].To != Chinese {
			t.Fatalf("status = %+v, %v", status, err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want cached status", calls.Load())
	}
	if _, err := service.TestConnection(context.Background(), administrator); err != nil || calls.Load() != 2 {
		t.Fatalf("test connection = %v, calls %d", err, calls.Load())
	}
	configure(t, service, second.URL, nil)
	status, err := service.Status(context.Background())
	if err != nil || status.Directions[0].To != Japanese || calls.Load() != 3 {
		t.Fatalf("status after update = %+v, %v, calls %d", status, err, calls.Load())
	}
}
