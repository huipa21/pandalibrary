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

type fakeDictionarySettingsService struct {
	viewers  []catalog.Viewer
	patches  []dictionary.SettingsPatch
	settings dictionary.Settings
	status   dictionary.Status
	err      error
	testErr  error
}

func (f *fakeDictionarySettingsService) Settings(_ context.Context, viewer catalog.Viewer) (dictionary.Settings, error) {
	f.viewers = append(f.viewers, viewer)
	return f.settings, f.err
}

func (f *fakeDictionarySettingsService) UpdateSettings(_ context.Context, viewer catalog.Viewer, patch dictionary.SettingsPatch) (dictionary.Settings, error) {
	f.viewers = append(f.viewers, viewer)
	f.patches = append(f.patches, patch)
	return f.settings, f.err
}

func (f *fakeDictionarySettingsService) TestConnection(_ context.Context, viewer catalog.Viewer) (dictionary.Status, error) {
	f.viewers = append(f.viewers, viewer)
	return f.status, f.testErr
}

type dictionaryHTTPFixture struct {
	catalogHTTPFixture
	service  *fakeDictionaryService
	settings *fakeDictionarySettingsService
	logs     *bytes.Buffer
}

func newDictionaryHTTPFixture(t *testing.T) dictionaryHTTPFixture {
	t.Helper()
	fixture := newCatalogHTTPFixture(t)
	authentication, err := auth.NewService(context.Background(), fixture.db.Writer, fixture.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	service := &fakeDictionaryService{}
	settings := &fakeDictionarySettingsService{}
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	protection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	DictionaryMount(service, settings, authentication, logger)(router, protection)
	fixture.router = router
	return dictionaryHTTPFixture{catalogHTTPFixture: fixture, service: service, settings: settings, logs: &logs}
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

func TestDictionaryHTTPAdminSettings(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	routes := []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/v1/admin/dictionary/settings", nil},
		{http.MethodPatch, "/api/v1/admin/dictionary/settings", map[string]any{"base_url": "https://dict.example"}},
		{http.MethodPost, "/api/v1/admin/dictionary/test", nil},
	}
	for _, route := range routes {
		requireProblem(t, authRequest(t, fixture.router, route.method, route.path, route.body, nil), http.StatusUnauthorized)
		requireProblem(t, authRequest(t, fixture.router, route.method, route.path, route.body, fixture.reader), http.StatusForbidden)
	}
	if len(fixture.settings.viewers) != 0 {
		t.Fatalf("settings service called without an administrator: %+v", fixture.settings.viewers)
	}

	baseURL := "https://dict.example"
	fixture.settings.settings = dictionary.Settings{BaseURL: &baseURL, HasAPIKey: true, UpdatedAt: time.UnixMilli(1700).UTC()}
	response := authRequest(t, fixture.router, http.MethodGet, "/api/v1/admin/dictionary/settings", nil, fixture.admin)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(response.Body.String(), `{"settings":{"base_url":"https://dict.example","has_api_key":true,`) {
		t.Fatalf("settings = %d %q %s", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
	if !fixture.settings.viewers[0].IsAdmin {
		t.Fatalf("viewer = %+v", fixture.settings.viewers[0])
	}

	const secret = "dictionary-write-only-key"
	response = authRequest(t, fixture.router, http.MethodPatch, "/api/v1/admin/dictionary/settings",
		map[string]any{"base_url": "https://dict.example", "api_key": secret}, fixture.admin)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		strings.Contains(response.Body.String(), secret) || !strings.Contains(response.Body.String(), `"has_api_key":true`) {
		t.Fatalf("update = %d %s", response.Code, response.Body.String())
	}
	patch := fixture.settings.patches[0]
	if !patch.BaseURL.Set || *patch.BaseURL.Value != baseURL || !patch.APIKey.Set || *patch.APIKey.Value != secret {
		t.Fatalf("patch = %+v", patch)
	}
	authRequest(t, fixture.router, http.MethodPatch, "/api/v1/admin/dictionary/settings", map[string]any{"api_key": nil}, fixture.admin)
	if patch = fixture.settings.patches[1]; patch.BaseURL.Set || !patch.APIKey.Set || patch.APIKey.Value != nil {
		t.Fatalf("clearing patch = %+v", patch)
	}

	for _, body := range []string{`{"unknown":true}`, `{"base_url":1}`, `{} {}`, `not json`} {
		response = fixture.request(http.MethodPatch, "/api/v1/admin/dictionary/settings", strings.NewReader(body), fixture.admin,
			map[string]string{"Content-Type": "application/json"})
		requireProblem(t, response, http.StatusBadRequest)
	}
	if len(fixture.settings.patches) != 2 {
		t.Fatalf("invalid bodies reached the service: %+v", fixture.settings.patches)
	}
	fixture.settings.err = fmt.Errorf("%w: base_url must use https", dictionary.ErrInvalid)
	response = authRequest(t, fixture.router, http.MethodPatch, "/api/v1/admin/dictionary/settings",
		map[string]any{"base_url": "ftp://dict.example"}, fixture.admin)
	requireProblem(t, response, http.StatusBadRequest)
	if !strings.Contains(response.Body.String(), "The dictionary settings are invalid.") {
		t.Fatalf("invalid settings = %s", response.Body.String())
	}
	fixture.settings.err = catalog.ErrForbidden
	requireProblem(t, authRequest(t, fixture.router, http.MethodGet, "/api/v1/admin/dictionary/settings", nil, fixture.admin), http.StatusForbidden)
	fixture.settings.err = nil

	for _, method := range []string{http.MethodPatch, http.MethodPost} {
		path := "/api/v1/admin/dictionary/settings"
		if method == http.MethodPost {
			path = "/api/v1/admin/dictionary/test"
		}
		calls := len(fixture.settings.viewers)
		response = fixture.request(method, path, strings.NewReader(`{}`), fixture.admin,
			map[string]string{"Content-Type": "application/json", "Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"})
		requireProblem(t, response, http.StatusForbidden)
		if len(fixture.settings.viewers) != calls {
			t.Fatalf("cross-site %s reached the service", method)
		}
	}
	if strings.Contains(fixture.logs.String(), secret) {
		t.Fatal("dictionary settings logged the API key")
	}
}

func TestDictionaryHTTPAdminTestConnection(t *testing.T) {
	fixture := newDictionaryHTTPFixture(t)
	response := authRequest(t, fixture.router, http.MethodPost, "/api/v1/admin/dictionary/test", nil, fixture.admin)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		strings.TrimSpace(response.Body.String()) != `{"status":{"directions":[],"sources":[]}}` {
		t.Fatalf("empty test = %d %q %s", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
	fixture.settings.status = dictionary.Status{
		Directions: []dictionary.Direction{{From: dictionary.English, To: dictionary.Japanese}},
	}
	response = authRequest(t, fixture.router, http.MethodPost, "/api/v1/admin/dictionary/test", nil, fixture.admin)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"sources":[]}],"sources":[]`) {
		t.Fatalf("test = %d %s", response.Code, response.Body.String())
	}

	for _, test := range []struct {
		err    error
		status int
		detail string
	}{
		{dictionary.ErrNotConfigured, http.StatusConflict, "Set the dictionary API address first."},
		{fmt.Errorf("%w: dial https://dict.example?key=secret-key", dictionary.ErrUnavailable), http.StatusBadGateway, "The dictionary API could not be reached."},
		{catalog.ErrForbidden, http.StatusForbidden, ""},
		{errors.New("boom secret-key"), http.StatusInternalServerError, ""},
	} {
		fixture.settings.testErr = test.err
		response = authRequest(t, fixture.router, http.MethodPost, "/api/v1/admin/dictionary/test", nil, fixture.admin)
		requireProblem(t, response, test.status)
		if response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), test.detail) ||
			strings.Contains(response.Body.String(), "secret-key") {
			t.Fatalf("%v = %q %s", test.err, response.Header().Get("Cache-Control"), response.Body.String())
		}
	}
	if strings.Contains(fixture.logs.String(), "secret-key") {
		t.Fatalf("connection test logged upstream details: %s", fixture.logs.String())
	}
}
