package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/metadata"

	"github.com/go-chi/chi/v5"
)

func TestMetadataAdminRoutesRedactionVisibilityAndSelections(t *testing.T) {
	fixture := newCatalogHTTPFixture(t)
	ctx := context.Background()
	store, err := blobstore.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	books, err := catalog.NewService(fixture.db.Writer, fixture.db.Reader, store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := metadata.NewService(fixture.db.Writer, fixture.db.Reader, books)
	if err != nil {
		t.Fatal(err)
	}
	authentication, err := auth.NewService(ctx, fixture.db.Writer, fixture.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	protection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	MetadataMount(service, authentication, logger)(router, protection)
	base := "/api/v1/books/101/metadata/"
	for _, test := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/admin/metadata/providers"},
		{http.MethodPatch, "/api/v1/admin/metadata/providers/neodb"},
		{http.MethodPost, base + "candidates"},
		{http.MethodPost, base + "apply"},
		{http.MethodPost, base + "cover"},
	} {
		requireProblem(t, authRequest(t, router, test.method, test.path, nil, nil), http.StatusUnauthorized)
		requireProblem(t, authRequest(t, router, test.method, test.path, nil, fixture.reader), http.StatusForbidden)
	}
	const secret = "metadata-write-only-secret"
	configured := authRequest(t, router, http.MethodPatch, "/api/v1/admin/metadata/providers/neodb",
		map[string]any{"enabled": true, "api_token": secret, "priority": 1}, fixture.admin)
	if configured.Code != http.StatusOK || strings.Contains(configured.Body.String(), secret) ||
		strings.Contains(configured.Body.String(), "api_token") || !strings.Contains(configured.Body.String(), `"has_token":true`) {
		t.Fatalf("provider update = %d %s", configured.Code, configured.Body.String())
	}
	list := authRequest(t, router, http.MethodGet, "/api/v1/admin/metadata/providers", nil, fixture.admin)
	if list.Code != http.StatusOK || strings.Contains(list.Body.String(), secret) || strings.Contains(logs.String(), secret) {
		t.Fatal("provider configuration disclosed a credential")
	}
	for _, body := range []any{
		map[string]any{"base_url": "https://user:password@neodb.social"},
		map[string]any{"base_url": "file:///etc/passwd"},
		map[string]any{"unknown": true},
	} {
		requireProblem(t, authRequest(t, router, http.MethodPatch, "/api/v1/admin/metadata/providers/neodb", body, fixture.admin), http.StatusBadRequest)
	}
	for _, path := range []string{
		"/api/v1/books/103/metadata/candidates", "/api/v1/books/999/metadata/candidates",
	} {
		requireProblem(t, authRequest(t, router, http.MethodPost, path, nil, fixture.admin), http.StatusNotFound)
	}
	// Disable all upstreams so this HTTP integration test cannot make live calls.
	if _, err := fixture.db.Writer.ExecContext(ctx, `UPDATE metadata_providers SET enabled = 0`); err != nil {
		t.Fatal(err)
	}
	lookup := authRequest(t, router, http.MethodPost, base+"candidates", nil, fixture.admin)
	var lookupDTO metadata.LookupResponse
	if lookup.Code != http.StatusOK || json.Unmarshal(lookup.Body.Bytes(), &lookupDTO) != nil ||
		lookupDTO.Query.Title != "Visible" || lookupDTO.Query.Author != "Shared Author" ||
		lookupDTO.RequestKey == "" || lookupDTO.Providers == nil || len(lookupDTO.Providers) != 0 ||
		lookup.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("lookup DTO = %d %s", lookup.Code, lookup.Body.String())
	}
	candidate := metadata.Candidate{Provider: "openlibrary", Reference: "/works/OL123W", Title: "Chosen Metadata Title",
		Authors: []metadata.Person{}, Tags: []string{}, Identifiers: []metadata.Identifier{}}
	cached, err := json.Marshal(metadata.ProviderResult{Provider: "openlibrary", Candidates: []metadata.Candidate{candidate}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		UPDATE metadata_providers SET enabled = 1 WHERE provider = 'openlibrary';
		INSERT INTO metadata_cache (provider, request_key, status, schema_version, response, fetched_at, expires_at)
		VALUES ('openlibrary', ?, 200, 1, ?, ?, ?)`,
		lookupDTO.RequestKey, string(cached), time.Now().UnixMilli(), time.Now().Add(time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"request_key": lookupDTO.RequestKey,
		"fields": map[string]any{"title": map[string]string{"provider": "openlibrary", "reference": "/works/OL123W"}}}
	applied := authRequest(t, router, http.MethodPost, base+"apply", request, fixture.admin)
	var appliedDTO struct {
		Book catalog.Book `json:"book"`
	}
	if applied.Code != http.StatusOK || json.Unmarshal(applied.Body.Bytes(), &appliedDTO) != nil ||
		appliedDTO.Book.Title != candidate.Title || appliedDTO.Book.CoverURL == nil ||
		len(appliedDTO.Book.Authors) != 1 || appliedDTO.Book.Authors[0].Name != "Shared Author" {
		t.Fatalf("applied DTO = %d %s", applied.Code, applied.Body.String())
	}
	if len(appliedDTO.Book.FieldSources) != 1 || appliedDTO.Book.FieldSources[0].Source != "openlibrary" {
		t.Fatalf("provenance = %+v", appliedDTO.Book.FieldSources)
	}
	request["patch"] = map[string]any{"subtitle": nil, "description": "Manual description", "tags": []string{"Manual tag"}}
	applied = authRequest(t, router, http.MethodPost, base+"apply", request, fixture.admin)
	if applied.Code != http.StatusOK || json.Unmarshal(applied.Body.Bytes(), &appliedDTO) != nil ||
		appliedDTO.Book.Title != candidate.Title || appliedDTO.Book.Subtitle != nil ||
		appliedDTO.Book.Description == nil || *appliedDTO.Book.Description != "Manual description" ||
		len(appliedDTO.Book.Tags) != 1 || appliedDTO.Book.Tags[0].Name != "Manual tag" {
		t.Fatalf("mixed apply DTO = %d %s", applied.Code, applied.Body.String())
	}
	if len(appliedDTO.Book.FieldSources) != 4 {
		t.Fatalf("mixed provenance = %+v", appliedDTO.Book.FieldSources)
	}
	for _, source := range appliedDTO.Book.FieldSources {
		if source.Field == "title" {
			if source.Source != "openlibrary" || source.SourceRef == nil || *source.SourceRef != candidate.Reference {
				t.Fatalf("mixed provider provenance = %+v", source)
			}
		} else if source.Source != "manual" || source.SourceRef != nil {
			t.Fatalf("mixed manual provenance = %+v", source)
		}
	}
	for _, patch := range []any{
		map[string]any{"title": "Colliding manual title"},
		map[string]any{"library_id": nil},
		map[string]any{"cover": "https://evil.example"},
		map[string]any{"unknown": true},
	} {
		request["patch"] = patch
		requireProblem(t, authRequest(t, router, http.MethodPost, base+"apply", request, fixture.admin), http.StatusBadRequest)
	}
	request["patch"] = map[string]any{"description": "Must not save"}
	injected := map[string]any{"request_key": lookupDTO.RequestKey, "fields": map[string]any{
		"title": map[string]string{"provider": "openlibrary", "reference": candidate.Reference, "value": "Injected Title"},
	}}
	requireProblem(t, authRequest(t, router, http.MethodPost, base+"apply", injected, fixture.admin), http.StatusBadRequest)
	requireProblem(t, authRequest(t, router, http.MethodPost, base+"cover", map[string]string{
		"request_key": lookupDTO.RequestKey, "provider": "openlibrary", "reference": candidate.Reference, "url": "https://evil.example",
	}, fixture.admin), http.StatusBadRequest)
	requireProblem(t, authRequest(t, router, http.MethodPost, base+"cover", metadata.CoverRequest{
		RequestKey: lookupDTO.RequestKey, Selection: metadata.Selection{Provider: "openlibrary", Reference: candidate.Reference},
	}, fixture.admin), http.StatusNotFound)
	request["request_key"] = "book:101:" + strings.Repeat("a", 64)
	requireProblem(t, authRequest(t, router, http.MethodPost, base+"apply", request, fixture.admin), http.StatusConflict)
	unchanged, err := books.GetBook(ctx, catalog.Viewer{UserID: 1, IsAdmin: true}, 101)
	if err != nil || unchanged.Title != candidate.Title || unchanged.Description == nil || *unchanged.Description != "Manual description" {
		t.Fatalf("rejected HTTP saves mutated book = %+v, %v", unchanged, err)
	}
	requireProblem(t, authRequest(t, router, http.MethodPost, base+"candidates?base_url=https://evil.example", nil, fixture.admin), http.StatusBadRequest)
	for _, path := range []string{base + "candidates", base + "apply", base + "cover", "/api/v1/admin/metadata/providers/neodb"} {
		method := http.MethodPost
		if strings.Contains(path, "/providers/") {
			method = http.MethodPatch
		}
		req := httptest.NewRequest(method, path, nil)
		req.AddCookie(fixture.admin)
		req.Header.Set("Origin", "https://evil.example")
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		requireProblem(t, recorder, http.StatusForbidden)
	}
	if strings.Contains(logs.String(), secret) {
		t.Fatal("metadata logs contain provider credentials")
	}
}
