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
	"strings"
	"testing"

	"pandalibrary/internal/auth"
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

type dictionaryHTTPFixture struct {
	catalogHTTPFixture
	service *fakeDictionaryService
	logs    *bytes.Buffer
}

func newDictionaryHTTPFixture(t *testing.T) dictionaryHTTPFixture {
	t.Helper()
	fixture := newCatalogHTTPFixture(t)
	authentication, err := auth.NewService(context.Background(), fixture.db.Writer, fixture.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	service := &fakeDictionaryService{}
	var logs bytes.Buffer
	router := chi.NewRouter()
	DictionaryMount(service, authentication, slog.New(slog.NewTextHandler(&logs, nil)))(router, nil)
	fixture.router = router
	return dictionaryHTTPFixture{catalogHTTPFixture: fixture, service: service, logs: &logs}
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
