package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/dictionary"

	"github.com/go-chi/chi/v5"
)

type fakeDictionaryService struct {
	queries   []dictionary.Query
	result    dictionary.Result
	status    dictionary.Status
	lookupErr error
	statusErr error
}

func (f *fakeDictionaryService) Lookup(_ context.Context, query dictionary.Query) (dictionary.Result, error) {
	f.queries = append(f.queries, query)
	return f.result, f.lookupErr
}

func (f *fakeDictionaryService) Status(context.Context) (dictionary.Status, error) {
	return f.status, f.statusErr
}

type fakeDictionaryAdminService struct {
	viewers   []catalog.Viewer
	ids       []int64
	inputs    []dictionary.ProviderInput
	patches   []dictionary.ProviderPatch
	providers dictionary.Providers
	provider  dictionary.Provider
	status    dictionary.Status
	deleted   int64
	err       error
}

func (f *fakeDictionaryAdminService) ListProviders(_ context.Context, viewer catalog.Viewer) (dictionary.Providers, error) {
	f.viewers = append(f.viewers, viewer)
	return f.providers, f.err
}

func (f *fakeDictionaryAdminService) CreateProvider(_ context.Context, viewer catalog.Viewer, input dictionary.ProviderInput) (dictionary.Provider, error) {
	f.viewers = append(f.viewers, viewer)
	f.inputs = append(f.inputs, input)
	return f.provider, f.err
}

func (f *fakeDictionaryAdminService) UpdateProvider(_ context.Context, viewer catalog.Viewer, id int64, patch dictionary.ProviderPatch) (dictionary.Provider, error) {
	f.viewers = append(f.viewers, viewer)
	f.ids = append(f.ids, id)
	f.patches = append(f.patches, patch)
	return f.provider, f.err
}

func (f *fakeDictionaryAdminService) DeleteProvider(_ context.Context, viewer catalog.Viewer, id int64) error {
	f.viewers = append(f.viewers, viewer)
	f.ids = append(f.ids, id)
	return f.err
}

func (f *fakeDictionaryAdminService) TestProvider(_ context.Context, viewer catalog.Viewer, id int64) (dictionary.Status, error) {
	f.viewers = append(f.viewers, viewer)
	f.ids = append(f.ids, id)
	return f.status, f.err
}

func (f *fakeDictionaryAdminService) ClearCache(_ context.Context, viewer catalog.Viewer) (int64, error) {
	f.viewers = append(f.viewers, viewer)
	return f.deleted, f.err
}

type dictionaryHTTPFixture struct {
	catalogHTTPFixture
	service      *fakeDictionaryService
	adminService *fakeDictionaryAdminService
	logs         *bytes.Buffer
}

func newDictionaryHTTPFixture(t *testing.T) dictionaryHTTPFixture {
	t.Helper()
	fixture := newCatalogHTTPFixture(t)
	authentication, err := auth.NewService(context.Background(), fixture.db.Writer, fixture.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	service := &fakeDictionaryService{}
	admin := &fakeDictionaryAdminService{}
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	protection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	DictionaryMount(service, admin, authentication, logger)(router, protection)
	fixture.router = router
	return dictionaryHTTPFixture{catalogHTTPFixture: fixture, service: service, adminService: admin, logs: &logs}
}

func (f dictionaryHTTPFixture) get(target string, cookie *http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	path, rawQuery, _ := strings.Cut(target, "?")
	request.URL.Path = path
	request.URL.RawQuery = rawQuery
	request.RemoteAddr = "192.0.2.10:54321"
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	f.router.ServeHTTP(response, request)
	return response
}

func TestDictionaryHTTPRequiresSession(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	for _, target := range []string{"/api/v1/dictionary/status", "/api/v1/dictionary/lookup?q=cat&from=en&to=zh"} {
		if response := fixture.get(target, nil); response.Code != http.StatusUnauthorized {
			t.Errorf("unauthenticated %s = %d", target, response.Code)
		}
	}
	if len(fixture.service.queries) != 0 {
		t.Fatalf("service called without a session: %+v", fixture.service.queries)
	}
}

func TestDictionaryHTTPLookup(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	fixture.service.result = dictionary.Result{
		Query: "Cats", Term: "cat", From: dictionary.English, To: dictionary.Chinese,
		Entries: []dictionary.Entry{
			{Source: "ecdict", SourceName: "ECDICT", Headword: "cat", Definitions: []string{"n. 猫"}, Match: dictionary.MatchLemma},
			{Source: "wiktionary-zh", SourceName: "Wiktionary", Headword: "cat", Match: dictionary.MatchLemma},
		},
	}
	response := fixture.get("/api/v1/dictionary/lookup?q=Cats&from=en&to=zh&limit=5", fixture.reader)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("lookup = %d %q %s", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
	want := dictionary.Query{Text: "Cats", From: dictionary.English, To: dictionary.Chinese, Limit: 5}
	if len(fixture.service.queries) != 1 || fixture.service.queries[0] != want {
		t.Fatalf("queries = %+v", fixture.service.queries)
	}
	const body = `{"query":"Cats","term":"cat","from":"en","to":"zh","entries":[` +
		`{"source":"ecdict","sourceName":"ECDICT","headword":"cat","definitions":["n. 猫"],"match":"lemma"},` +
		`{"source":"wiktionary-zh","sourceName":"Wiktionary","headword":"cat","definitions":[],"match":"lemma"}]}`
	if strings.TrimSpace(response.Body.String()) != body {
		t.Fatalf("body = %s", response.Body.String())
	}

	fixture.service.result = dictionary.Result{Query: "猫", From: dictionary.Japanese, To: dictionary.English}
	response = fixture.get("/api/v1/dictionary/lookup?q=%E7%8C%AB&from=ja&to=en", fixture.admin)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"entries":[]`) {
		t.Fatalf("empty lookup = %d %s", response.Code, response.Body.String())
	}
	if last := fixture.service.queries[len(fixture.service.queries)-1]; last.Limit != 0 || last.Text != "猫" {
		t.Fatalf("default limit query = %+v", last)
	}
}

func TestDictionaryHTTPBadRequests(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	for _, target := range []string{
		"/api/v1/dictionary/lookup",
		"/api/v1/dictionary/lookup?q=cat",
		"/api/v1/dictionary/lookup?from=en&to=zh",
		"/api/v1/dictionary/lookup?q=&from=en&to=zh",
		"/api/v1/dictionary/lookup?q=cat&from=&to=zh",
		"/api/v1/dictionary/lookup?q=cat&from=en",
		"/api/v1/dictionary/lookup?q=cat&from=fr&to=zh",
		"/api/v1/dictionary/lookup?q=cat&from=en&to=zh-TW",
		"/api/v1/dictionary/lookup?q=cat&q=dog&from=en&to=zh",
		"/api/v1/dictionary/lookup?q=cat&from=en&to=zh&unknown=x",
		"/api/v1/dictionary/lookup?q=%ZZ&from=en&to=zh",
		"/api/v1/dictionary/lookup?q=cat&from=en&to=zh&limit=0",
		"/api/v1/dictionary/lookup?q=cat&from=en&to=zh&limit=51",
		"/api/v1/dictionary/lookup?q=cat&from=en&to=zh&limit=abc",
		"/api/v1/dictionary/lookup?q=cat&from=en&to=zh&limit=1&limit=2",
		"/api/v1/dictionary/status?verbose=1",
	} {
		response := fixture.get(target, fixture.reader)
		if response.Code != http.StatusBadRequest ||
			!strings.Contains(response.Header().Get("Content-Type"), "application/problem+json") {
			t.Errorf("%s = %d %s", target, response.Code, response.Body.String())
		}
	}
	if len(fixture.service.queries) != 0 {
		t.Fatalf("service called for invalid requests: %+v", fixture.service.queries)
	}

	fixture.service.lookupErr = fmt.Errorf("%w: the selection is too long", dictionary.ErrInvalid)
	response := fixture.get("/api/v1/dictionary/lookup?q=cat&from=en&to=zh", fixture.reader)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "the selection is too long") ||
		strings.Contains(response.Body.String(), "invalid dictionary request") {
		t.Fatalf("invalid lookup = %d %s", response.Code, response.Body.String())
	}

	fixture.service.lookupErr = errors.New("disk exploded")
	response = fixture.get("/api/v1/dictionary/lookup?q=cat&from=en&to=zh", fixture.reader)
	if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "disk exploded") ||
		!strings.Contains(fixture.logs.String(), "dictionary lookup failed") {
		t.Fatalf("failed lookup = %d %s, logs = %s", response.Code, response.Body.String(), fixture.logs.String())
	}
}

func TestDictionaryHTTPStatus(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	response := fixture.get("/api/v1/dictionary/status", fixture.reader)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		strings.TrimSpace(response.Body.String()) != `{"directions":[],"sources":[]}` {
		t.Fatalf("empty status = %d %q %s", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}

	fixture.service.status = dictionary.Status{
		Directions: []dictionary.Direction{{From: dictionary.English, To: dictionary.Chinese, Sources: []string{"ecdict"}}},
		Sources: []dictionary.SourceInfo{{
			ID: "ecdict", Name: "ECDICT", License: "MIT", URL: "https://example.test", Entries: 3, ImportedAt: 1700,
		}},
	}
	response = fixture.get("/api/v1/dictionary/status", fixture.reader)
	var status dictionary.Status
	if err := json.Unmarshal(response.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || len(status.Directions) != 1 || status.Directions[0].Sources[0] != "ecdict" ||
		len(status.Sources) != 1 || status.Sources[0].Entries != 3 || status.Sources[0].ImportedAt != 1700 {
		t.Fatalf("status = %d %s", response.Code, response.Body.String())
	}

	fixture.service.statusErr = errors.New("broken")
	response = fixture.get("/api/v1/dictionary/status", fixture.reader)
	if response.Code != http.StatusInternalServerError || !strings.Contains(fixture.logs.String(), "dictionary status failed") {
		t.Fatalf("failed status = %d %s", response.Code, response.Body.String())
	}
	_ = io.Discard
}

func TestDictionaryHTTPUnavailable(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	for _, err := range []error{
		dictionary.ErrNotConfigured,
		fmt.Errorf("%w: GET https://dict.example/?key=secret-key: timeout", dictionary.ErrUnavailable),
	} {
		fixture.service.lookupErr = err
		fixture.service.statusErr = err
		for _, target := range []string{"/api/v1/dictionary/status", "/api/v1/dictionary/lookup?q=cat&from=en&to=zh"} {
			response := fixture.get(target, fixture.reader)
			requireProblem(t, response, http.StatusServiceUnavailable)
			if !strings.Contains(response.Body.String(), "The online dictionary is unavailable.") ||
				strings.Contains(response.Body.String(), "secret-key") {
				t.Fatalf("%s unavailable = %s", target, response.Body.String())
			}
		}
	}
	if !strings.Contains(fixture.logs.String(), "level=WARN") || strings.Contains(fixture.logs.String(), "secret-key") {
		t.Fatalf("unavailable logs = %s", fixture.logs.String())
	}
}

func TestDictionaryHTTPAdminProvidersAccess(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	routes := []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/v1/admin/dictionary/providers", nil},
		{http.MethodPost, "/api/v1/admin/dictionary/providers", map[string]any{"name": "Mine", "base_url": "https://dict.example"}},
		{http.MethodPatch, "/api/v1/admin/dictionary/providers/1", map[string]any{"enabled": true}},
		{http.MethodDelete, "/api/v1/admin/dictionary/providers/1", nil},
		{http.MethodPost, "/api/v1/admin/dictionary/providers/1/test", nil},
		{http.MethodDelete, "/api/v1/admin/dictionary/cache", nil},
	}
	for _, route := range routes {
		requireProblem(t, authRequest(t, fixture.router, route.method, route.path, route.body, nil), http.StatusUnauthorized)
		requireProblem(t, authRequest(t, fixture.router, route.method, route.path, route.body, fixture.reader), http.StatusForbidden)
		if route.method == http.MethodGet {
			continue
		}
		response := fixture.request(route.method, route.path, strings.NewReader(`{}`), fixture.admin,
			map[string]string{"Content-Type": "application/json", "Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"})
		requireProblem(t, response, http.StatusForbidden)
	}
	if len(fixture.adminService.viewers) != 0 {
		t.Fatalf("admin service called without an allowed administrator request: %+v", fixture.adminService.viewers)
	}
}

func TestDictionaryHTTPAdminProviders(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	response := authRequest(t, fixture.router, http.MethodGet, "/api/v1/admin/dictionary/providers", nil, fixture.admin)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		strings.TrimSpace(response.Body.String()) != `{"providers":[],"cache_entries":0}` {
		t.Fatalf("empty list = %d %q %s", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
	if !fixture.adminService.viewers[0].IsAdmin {
		t.Fatalf("viewer = %+v", fixture.adminService.viewers[0])
	}

	baseURL := "https://dict.example"
	fixture.adminService.providers = dictionary.Providers{
		Providers: []dictionary.Provider{
			{ID: 1, Kind: dictionary.KindMWCollegiate, Preset: true, Directions: []dictionary.Direction{{From: dictionary.English, To: dictionary.English}}},
			{ID: 3, Kind: dictionary.KindCustom, BaseURL: &baseURL, HasAPIKey: true},
		},
		CacheEntries: 7,
	}
	response = authRequest(t, fixture.router, http.MethodGet, "/api/v1/admin/dictionary/providers", nil, fixture.admin)
	body := response.Body.String()
	if response.Code != http.StatusOK || !strings.Contains(body, `"directions":[{"from":"en","to":"en","sources":[]}]`) ||
		!strings.Contains(body, `"base_url":"https://dict.example","has_api_key":true`) || !strings.Contains(body, `"directions":[]`) ||
		!strings.HasSuffix(strings.TrimSpace(body), `"cache_entries":7}`) {
		t.Fatalf("list = %d %s", response.Code, body)
	}

	const secret = "dictionary-write-only-key"
	fixture.adminService.provider = dictionary.Provider{ID: 4, Kind: dictionary.KindCustom, Name: "Mine", BaseURL: &baseURL, HasAPIKey: true, UpdatedAt: time.UnixMilli(1700).UTC()}
	response = authRequest(t, fixture.router, http.MethodPost, "/api/v1/admin/dictionary/providers",
		map[string]any{"name": "Mine", "base_url": baseURL, "api_key": secret, "priority": 5}, fixture.admin)
	if response.Code != http.StatusCreated || response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), secret) ||
		!strings.Contains(response.Body.String(), `{"provider":{"id":4,"kind":"custom","name":"Mine"`) || !strings.Contains(response.Body.String(), `"directions":[]`) {
		t.Fatalf("create = %d %s", response.Code, response.Body.String())
	}
	if input := fixture.adminService.inputs[0]; input.Name != "Mine" || input.BaseURL != baseURL || *input.APIKey != secret || *input.Priority != 5 {
		t.Fatalf("input = %+v", input)
	}

	response = authRequest(t, fixture.router, http.MethodPatch, "/api/v1/admin/dictionary/providers/4",
		map[string]any{"api_key": nil, "enabled": false}, fixture.admin)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(response.Body.String(), `{"provider":{"id":4`) {
		t.Fatalf("update = %d %s", response.Code, response.Body.String())
	}
	if patch := fixture.adminService.patches[0]; fixture.adminService.ids[0] != 4 || !patch.APIKey.Set || patch.APIKey.Value != nil ||
		!patch.Enabled.Set || *patch.Enabled.Value || patch.Name.Set || patch.BaseURL.Set {
		t.Fatalf("patch %v = %+v", fixture.adminService.ids, patch)
	}

	response = authRequest(t, fixture.router, http.MethodDelete, "/api/v1/admin/dictionary/providers/4", nil, fixture.admin)
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 || fixture.adminService.ids[1] != 4 {
		t.Fatalf("delete = %d %s %v", response.Code, response.Body.String(), fixture.adminService.ids)
	}

	fixture.adminService.status = dictionary.Status{Directions: []dictionary.Direction{{From: dictionary.English, To: dictionary.Japanese}}}
	response = authRequest(t, fixture.router, http.MethodPost, "/api/v1/admin/dictionary/providers/4/test", nil, fixture.admin)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" || fixture.adminService.ids[2] != 4 ||
		strings.TrimSpace(response.Body.String()) != `{"status":{"directions":[{"from":"en","to":"ja","sources":[]}],"sources":[]}}` {
		t.Fatalf("test = %d %s", response.Code, response.Body.String())
	}

	fixture.adminService.deleted = 12
	response = authRequest(t, fixture.router, http.MethodDelete, "/api/v1/admin/dictionary/cache", nil, fixture.admin)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		strings.TrimSpace(response.Body.String()) != `{"deleted":12}` {
		t.Fatalf("clear cache = %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(fixture.logs.String(), secret) {
		t.Fatal("dictionary provider routes logged the API key")
	}
}

func TestDictionaryHTTPAdminProviderBadRequests(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	for _, route := range []struct{ method, path string }{
		{http.MethodPatch, "/api/v1/admin/dictionary/providers/0"},
		{http.MethodPatch, "/api/v1/admin/dictionary/providers/abc"},
		{http.MethodDelete, "/api/v1/admin/dictionary/providers/-1"},
		{http.MethodPost, "/api/v1/admin/dictionary/providers/x/test"},
	} {
		response := authRequest(t, fixture.router, route.method, route.path, map[string]any{}, fixture.admin)
		requireProblem(t, response, http.StatusBadRequest)
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s missing no-store", route.method, route.path)
		}
	}
	for _, path := range []string{"/api/v1/admin/dictionary/providers", "/api/v1/admin/dictionary/providers/2"} {
		method := http.MethodPost
		if strings.HasSuffix(path, "/2") {
			method = http.MethodPatch
		}
		for _, body := range []string{`{"unknown":true}`, `{"name":1}`, `{} {}`, `not json`} {
			response := fixture.request(method, path, strings.NewReader(body), fixture.admin,
				map[string]string{"Content-Type": "application/json"})
			requireProblem(t, response, http.StatusBadRequest)
		}
	}
	if len(fixture.adminService.viewers) != 0 {
		t.Fatalf("invalid requests reached the service: %+v", fixture.adminService.viewers)
	}
}

func TestDictionaryHTTPAdminProviderErrors(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	routes := []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/v1/admin/dictionary/providers", nil},
		{http.MethodPost, "/api/v1/admin/dictionary/providers", map[string]any{"name": "Mine", "base_url": "ftp://dict.example"}},
		{http.MethodPatch, "/api/v1/admin/dictionary/providers/9", map[string]any{"priority": 1}},
		{http.MethodDelete, "/api/v1/admin/dictionary/providers/9", nil},
		{http.MethodPost, "/api/v1/admin/dictionary/providers/9/test", nil},
		{http.MethodDelete, "/api/v1/admin/dictionary/cache", nil},
	}
	for _, test := range []struct {
		err    error
		status int
		detail string
	}{
		{fmt.Errorf("%w: base_url must use https secret-key", dictionary.ErrInvalid), http.StatusBadRequest, "The dictionary provider settings are invalid."},
		{dictionary.ErrNotFound, http.StatusNotFound, ""},
		{dictionary.ErrNotConfigured, http.StatusConflict, "Enter the provider's API key or address first."},
		{fmt.Errorf("%w: dial https://dict.example?key=secret-key", dictionary.ErrUnavailable), http.StatusBadGateway, "The dictionary provider could not be reached."},
		{catalog.ErrForbidden, http.StatusForbidden, ""},
		{errors.New("boom secret-key"), http.StatusInternalServerError, ""},
	} {
		fixture.adminService.err = test.err
		for _, route := range routes {
			response := authRequest(t, fixture.router, route.method, route.path, route.body, fixture.admin)
			requireProblem(t, response, test.status)
			if response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), test.detail) ||
				strings.Contains(response.Body.String(), "secret-key") {
				t.Fatalf("%s %s %v = %q %s", route.method, route.path, test.err, response.Header().Get("Cache-Control"), response.Body.String())
			}
		}
	}
	if strings.Contains(fixture.logs.String(), "secret-key") {
		t.Fatalf("dictionary admin routes logged raw errors: %s", fixture.logs.String())
	}
}
