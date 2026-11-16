package dictionary

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
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

func newTestService(t *testing.T, logger *slog.Logger) *Service {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "dictionary.db")
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
	cache, err := OpenCache(ctx, filepath.Join(dir, "cache.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := cache.Close(); err != nil {
			t.Error(err)
		}
	})
	return NewService(database.Writer, database.Reader, cache, logger)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func providerByKind(t *testing.T, service *Service, kind string) Provider {
	t.Helper()
	providers, err := service.ListProviders(context.Background(), administrator)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range providers.Providers {
		if p.Kind == kind {
			return p
		}
	}
	t.Fatalf("provider %s is missing: %+v", kind, providers)
	return Provider{}
}

func set[T any](value T) catalog.Optional[T] { return catalog.Optional[T]{Set: true, Value: &value} }

func patchProvider(t *testing.T, service *Service, id int64, patch ProviderPatch) Provider {
	t.Helper()
	provider, err := service.UpdateProvider(context.Background(), administrator, id, patch)
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

// customServer serves the custom protocol: every direction in directions and one entry per lookup.
func customServer(t *testing.T, source string, directions [][2]string, lookups *atomic.Int64) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/status":
			list := []map[string]any{}
			for _, d := range directions {
				list = append(list, map[string]any{"from": d[0], "to": d[1], "sources": []string{source}})
			}
			writeJSON(w, http.StatusOK, map[string]any{"directions": list, "sources": []map[string]any{{"id": source, "name": source}}})
		case "/lookup":
			if lookups != nil {
				lookups.Add(1)
			}
			switch q := r.URL.Query().Get("q"); q {
			case "fail":
				http.Error(w, "boom", http.StatusInternalServerError)
			case "bad":
				w.Header().Set("Content-Type", "application/problem+json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"detail":"Unsupported query."}`))
			default:
				writeJSON(w, http.StatusOK, map[string]any{"entries": []map[string]any{{
					"source": source, "sourceName": source, "headword": q + "-" + source, "definitions": []string{source}, "match": "exact",
				}}})
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestServicePresetsAreSeededAndKeyEnables(t *testing.T) {
	ctx := context.Background()
	service := newTestService(t, nil)
	providers, err := service.ListProviders(ctx, administrator)
	if err != nil {
		t.Fatal(err)
	}
	if len(providers.Providers) != 2 || providers.CacheEntries != 0 {
		t.Fatalf("providers = %+v", providers)
	}
	for _, p := range providers.Providers {
		if !p.Preset || p.Enabled || p.HasAPIKey || p.SignupURL == "" || p.BaseURL != nil || len(p.Directions) != 1 {
			t.Fatalf("preset = %+v", p)
		}
	}
	status, err := service.Status(ctx)
	if err != nil || status.Directions == nil || status.Sources == nil || len(status.Directions) != 0 {
		t.Fatalf("status = %+v, %v", status, err)
	}
	if _, err := service.Lookup(ctx, Query{Text: "run", From: English, To: English}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("lookup error = %v", err)
	}
	collegiate := providerByKind(t, service, KindMWCollegiate)
	if _, err := service.TestProvider(ctx, administrator, collegiate.ID); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("test error = %v", err)
	}
	for name, patch := range map[string]ProviderPatch{
		"empty":         {},
		"enable no key": {Enabled: set(true)},
		"name":          {Name: set("Other")},
		"base url":      {BaseURL: set("https://example.com")},
		"blank key":     {APIKey: set("  ")},
		"priority":      {Priority: set(int64(10001))},
	} {
		if _, err := service.UpdateProvider(ctx, administrator, collegiate.ID, patch); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: error = %v", name, err)
		}
	}
	if err := service.DeleteProvider(ctx, administrator, collegiate.ID); !errors.Is(err, ErrInvalid) {
		t.Fatalf("delete preset error = %v", err)
	}
	if _, err := service.UpdateProvider(ctx, administrator, 9999, ProviderPatch{Priority: set(int64(1))}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing provider error = %v", err)
	}

	updated := patchProvider(t, service, collegiate.ID, ProviderPatch{APIKey: set(" mw-secret-key ")})
	if !updated.Enabled || !updated.HasAPIKey {
		t.Fatalf("key did not enable the preset: %+v", updated)
	}
	data, _ := json.Marshal(mustList(t, service))
	if strings.Contains(string(data), "mw-secret-key") {
		t.Fatalf("providers leak the API key: %s", data)
	}
	status, err = service.Status(ctx)
	if err != nil || len(status.Directions) != 1 || status.Directions[0].Sources[0] != KindMWCollegiate ||
		len(status.Sources) != 1 || status.Sources[0].ID != KindMWCollegiate {
		t.Fatalf("status = %+v, %v", status, err)
	}

	updated = patchProvider(t, service, collegiate.ID, ProviderPatch{Enabled: set(false)})
	if updated.Enabled || !updated.HasAPIKey {
		t.Fatalf("disable = %+v", updated)
	}
	updated = patchProvider(t, service, collegiate.ID, ProviderPatch{APIKey: set("other-key"), Enabled: set(false)})
	if updated.Enabled {
		t.Fatalf("explicit enabled=false was overridden: %+v", updated)
	}
	patchProvider(t, service, collegiate.ID, ProviderPatch{Enabled: set(true)})
	updated = patchProvider(t, service, collegiate.ID, ProviderPatch{APIKey: catalog.Optional[string]{Set: true}})
	if updated.Enabled || updated.HasAPIKey {
		t.Fatalf("clearing the key did not disable the preset: %+v", updated)
	}
}

func mustList(t *testing.T, service *Service) Providers {
	t.Helper()
	providers, err := service.ListProviders(context.Background(), administrator)
	if err != nil {
		t.Fatal(err)
	}
	return providers
}

func TestServiceMWLookupUsesCache(t *testing.T) {
	ctx := context.Background()
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Query().Get("key") != "mw-secret" {
			t.Errorf("key = %q", r.URL.Query().Get("key"))
		}
		switch r.URL.Path {
		case "/collegiate/run", "/collegiate/test":
			writeJSON(w, http.StatusOK, []map[string]any{{
				"meta": map[string]any{"id": "run:1", "stems": []string{"run"}}, "hwi": map[string]any{"hw": "run"},
				"fl": "verb", "shortdef": []string{"to go faster than a walk"},
			}})
		case "/collegiate/zzzz":
			writeJSON(w, http.StatusOK, []string{"buzz"})
		default:
			http.Error(w, "boom", http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	var logs bytes.Buffer
	service := newTestService(t, slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	service.presetBases = map[string]string{KindMWCollegiate: server.URL + "/collegiate/"}
	collegiate := providerByKind(t, service, KindMWCollegiate)
	patchProvider(t, service, collegiate.ID, ProviderPatch{APIKey: set("mw-secret")})

	for i, text := range []string{"run", " RUN "} {
		result, err := service.Lookup(ctx, Query{Text: text, From: English, To: English})
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Entries) == 0 || result.Term != "run" || result.Entries[0].Source != KindMWCollegiate ||
			result.Entries[0].From != English || result.Entries[0].To != English {
			t.Fatalf("lookup %d = %+v", i, result)
		}
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d, want 1 (second lookup cached)", requests.Load())
	}
	result, err := service.Lookup(ctx, Query{Text: "zzzz", From: English, To: English})
	if err != nil || len(result.Entries) != 0 || result.Term != "zzzz" {
		t.Fatalf("suggestions = %+v, %v", result, err)
	}
	if providers := mustList(t, service); providers.CacheEntries != 2 {
		t.Fatalf("cache entries = %d", providers.CacheEntries)
	}
	if _, err := service.Lookup(ctx, Query{Text: "boom", From: English, To: English}); !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "mw-secret") {
		t.Fatalf("failing lookup error = %v", err)
	}
	if _, err := service.Lookup(ctx, Query{Text: "boom", From: English, To: English}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("failures must not be cached: %v", err)
	}
	if strings.Contains(logs.String(), "mw-secret") {
		t.Fatalf("logs leak the API key: %s", logs.String())
	}

	before := requests.Load()
	status, err := service.TestProvider(ctx, administrator, collegiate.ID)
	if err != nil || len(status.Directions) != 1 || status.Sources[0].ID != KindMWCollegiate || requests.Load() != before+1 {
		t.Fatalf("test = %+v, %v (requests %d)", status, err, requests.Load())
	}
	removed, err := service.ClearCache(ctx, administrator)
	if err != nil || removed != 2 {
		t.Fatalf("clear = %d, %v", removed, err)
	}
	if _, err := service.Lookup(ctx, Query{Text: "run", From: English, To: English}); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != before+2 {
		t.Fatalf("lookup after clear was not fetched: %d", requests.Load())
	}
}

func TestServiceCustomProviderLifecycle(t *testing.T) {
	ctx := context.Background()
	var firstLookups, secondLookups atomic.Int64
	first := customServer(t, "first", [][2]string{{"en", "zh"}}, &firstLookups)
	second := customServer(t, "second", [][2]string{{"en", "zh"}}, &secondLookups)
	service := newTestService(t, nil)

	for name, input := range map[string]ProviderInput{
		"name":     {Name: " ", BaseURL: first.URL},
		"control":  {Name: "a\x00b", BaseURL: first.URL},
		"base url": {Name: "Mine", BaseURL: "ftp://example.com"},
		"query":    {Name: "Mine", BaseURL: first.URL + "?x=1"},
		"key":      {Name: "Mine", BaseURL: first.URL, APIKey: new("a b")},
		"priority": {Name: "Mine", BaseURL: first.URL, Priority: new(int64(-1))},
	} {
		if _, err := service.CreateProvider(ctx, administrator, input); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: error = %v", name, err)
		}
	}
	created, err := service.CreateProvider(ctx, administrator, ProviderInput{Name: " Mine ", BaseURL: " " + first.URL + "/ ", APIKey: new("custom-secret")})
	if err != nil {
		t.Fatal(err)
	}
	if created.Preset || created.Kind != KindCustom || created.Name != "Mine" || !created.Enabled || !created.HasAPIKey ||
		created.BaseURL == nil || *created.BaseURL != first.URL || created.Priority != 30 {
		t.Fatalf("created = %+v", created)
	}

	for range 2 {
		result, err := service.Lookup(ctx, Query{Text: "run", From: English, To: Chinese})
		if err != nil || len(result.Entries) != 1 || result.Entries[0].Headword != "run-first" || result.Entries[0].From != English {
			t.Fatalf("lookup = %+v, %v", result, err)
		}
	}
	if firstLookups.Load() != 1 {
		t.Fatalf("first lookups = %d, want 1", firstLookups.Load())
	}
	if p := providerByKind(t, service, KindCustom); len(p.Directions) != 1 || p.Directions[0].To != Chinese {
		t.Fatalf("listed custom provider = %+v", p)
	}

	for name, patch := range map[string]ProviderPatch{
		"null base": {BaseURL: catalog.Optional[string]{Set: true}},
		"null name": {Name: catalog.Optional[string]{Set: true}},
		"bad base":  {BaseURL: set("not a url")},
	} {
		if _, err := service.UpdateProvider(ctx, administrator, created.ID, patch); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: error = %v", name, err)
		}
	}
	updated := patchProvider(t, service, created.ID, ProviderPatch{BaseURL: set(second.URL), Name: set("Renamed")})
	if updated.Name != "Renamed" || *updated.BaseURL != second.URL {
		t.Fatalf("updated = %+v", updated)
	}
	result, err := service.Lookup(ctx, Query{Text: "run", From: English, To: Chinese})
	if err != nil || len(result.Entries) != 1 || result.Entries[0].Headword != "run-second" || secondLookups.Load() != 1 {
		t.Fatalf("lookup after base change = %+v, %v (second lookups %d)", result, err, secondLookups.Load())
	}

	if err := service.DeleteProvider(ctx, administrator, created.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteProvider(ctx, administrator, created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete error = %v", err)
	}
	if providers := mustList(t, service); len(providers.Providers) != 2 || providers.CacheEntries != 0 {
		t.Fatalf("providers after delete = %+v", providers)
	}
	if _, err := service.Lookup(ctx, Query{Text: "run", From: English, To: Chinese}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("lookup after delete error = %v", err)
	}
}

func TestServiceStatusUnionAndPartialFailure(t *testing.T) {
	ctx := context.Background()
	a := customServer(t, "a", [][2]string{{"en", "zh"}}, nil)
	b := customServer(t, "b", [][2]string{{"zh", "en"}, {"en", "zh"}, {"en", "fr"}}, nil)
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer down.Close()
	service := newTestService(t, nil)
	for _, input := range []ProviderInput{
		{Name: "A", BaseURL: a.URL, Priority: new(int64(50))},
		{Name: "B", BaseURL: b.URL, Priority: new(int64(10))},
		{Name: "Down", BaseURL: down.URL},
	} {
		if _, err := service.CreateProvider(ctx, administrator, input); err != nil {
			t.Fatal(err)
		}
	}
	status, err := service.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(status.Directions) != 2 || status.Directions[0].From != English || status.Directions[0].To != Chinese ||
		strings.Join(status.Directions[0].Sources, ",") != "b,a" || status.Directions[1].From != Chinese || len(status.Sources) != 2 {
		t.Fatalf("status = %+v", status)
	}

	result, err := service.Lookup(ctx, Query{Text: "run", From: English, To: Chinese})
	if err != nil || len(result.Entries) != 2 || result.Entries[0].Headword != "run-b" || result.Entries[1].Headword != "run-a" || result.Term != "run-b" {
		t.Fatalf("lookup = %+v, %v", result, err)
	}
	result, err = service.Lookup(ctx, Query{Text: "run", From: English, To: Chinese, Limit: 1})
	if err != nil || len(result.Entries) != 1 {
		t.Fatalf("limited lookup = %+v, %v", result, err)
	}
	result, err = service.Lookup(ctx, Query{Text: "run", From: Chinese, To: English})
	if err != nil || len(result.Entries) != 1 || result.Entries[0].Headword != "run-b" {
		t.Fatalf("zh-en lookup = %+v, %v", result, err)
	}
	if _, err := service.Lookup(ctx, Query{Text: "fail", From: English, To: Chinese}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("all failed error = %v", err)
	}
	if _, err := service.Lookup(ctx, Query{Text: "bad", From: Chinese, To: English}); !errors.Is(err, ErrInvalid) ||
		err.Error() != "invalid dictionary request: Unsupported query." {
		t.Fatalf("400 error = %v", err)
	}
	if _, err := service.Lookup(ctx, Query{Text: "run", From: Japanese, To: English}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("direction served only by an unreachable provider: %v", err)
	}
	if _, err := service.Lookup(ctx, Query{Text: strings.Repeat("あ", MaxQueryRunes+1), From: Japanese, To: English}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("long lookup error = %v", err)
	}
	if _, err := service.Lookup(ctx, Query{Text: "run", From: "fr", To: English}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("language error = %v", err)
	}
	downID := providerByName(t, service, "Down")
	if _, err := service.TestProvider(ctx, administrator, downID); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("test down error = %v", err)
	}
}

func providerByName(t *testing.T, service *Service, name string) int64 {
	t.Helper()
	for _, p := range mustList(t, service).Providers {
		if p.Name == name {
			return p.ID
		}
	}
	t.Fatalf("provider %q is missing", name)
	return 0
}

func TestServiceAdminForbidden(t *testing.T) {
	ctx := context.Background()
	service := newTestService(t, nil)
	for _, viewer := range []catalog.Viewer{{UserID: 2}, {}} {
		checks := map[string]error{}
		_, checks["list"] = service.ListProviders(ctx, viewer)
		_, checks["create"] = service.CreateProvider(ctx, viewer, ProviderInput{Name: "x", BaseURL: "https://example.com"})
		_, checks["update"] = service.UpdateProvider(ctx, viewer, 1, ProviderPatch{Priority: set(int64(1))})
		checks["delete"] = service.DeleteProvider(ctx, viewer, 1)
		_, checks["test"] = service.TestProvider(ctx, viewer, 1)
		_, checks["clear"] = service.ClearCache(ctx, viewer)
		for name, err := range checks {
			if !errors.Is(err, catalog.ErrForbidden) {
				t.Fatalf("%s as %+v: error = %v", name, viewer, err)
			}
		}
	}
}
