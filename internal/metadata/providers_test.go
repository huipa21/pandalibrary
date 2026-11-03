package metadata

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func testAdapter(t *testing.T, name string, handler http.HandlerFunc) *adapter {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	return &adapter{name: name, base: base, token: "fixture-credential", client: server.Client()}
}

func TestProviderFixturesAndISBNPrecedence(t *testing.T) {
	for _, name := range []string{"openlibrary", "googlebooks", "neodb", "hardcover"} {
		t.Run(name, func(t *testing.T) {
			data := fixture(t, name)
			p := testAdapter(t, name, func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("User-Agent") != userAgent {
					t.Error("missing descriptive User-Agent")
				}
				query := r.URL.Query()
				if query.Get("title") != "" || query.Get("author") != "" || query.Get("langRestrict") != "" {
					t.Error("ISBN search leaked fallback fields")
				}
				switch name {
				case "openlibrary":
					if r.URL.Path != "/search.json" || query.Get("isbn") != "9781234567897" || query.Get("limit") != "10" {
						t.Errorf("Open Library request = %s", r.URL)
					}
				case "googlebooks":
					if r.URL.Path != "/books/v1/volumes" || query.Get("q") != "isbn:9781234567897" || query.Get("key") != "fixture-credential" {
						t.Error("invalid Google Books contract")
					}
				case "neodb":
					if r.URL.Path != "/api/catalog/search" || query.Get("query") != "9781234567897" ||
						query.Get("category") != "book" || r.Header.Get("Authorization") != "Bearer fixture-credential" {
						t.Error("invalid NeoDB contract")
					}
				case "hardcover":
					var body struct {
						Query     string            `json:"query"`
						Variables map[string]string `json:"variables"`
					}
					if json.NewDecoder(r.Body).Decode(&body) != nil || r.Method != http.MethodPost ||
						r.URL.Path != "/v1/graphql" || !strings.Contains(body.Query, `query_type: "Book"`) ||
						body.Variables["query"] != "9781234567897" || r.Header.Get("Authorization") != "Bearer fixture-credential" {
						t.Error("invalid Hardcover contract")
					}
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write(data)
			})
			result, err := p.Search(context.Background(), Query{ISBN: "9781234567897", Title: "Ignored", Author: "Ignored", Language: "xx"})
			if err != nil || len(result) != 1 {
				t.Fatalf("Search = %+v, %v", result, err)
			}
			c := result[0]
			if c.Provider != name || c.Reference == "" || c.Title != "Test Library" || c.Subtitle == nil ||
				len(c.Authors) == 0 || c.Authors[0].Role != "author" || c.Authors[0].Name != "Test Author" ||
				c.PageCount == nil || *c.PageCount != 321 || c.PublishedDate == nil ||
				len(c.Tags) == 0 || len(c.Identifiers) != 2 || c.CoverURL == nil {
				t.Fatalf("normalization = %+v", c)
			}
			if name == "neodb" && (len(c.Authors) != 2 || c.Authors[1].Role != "translator") {
				t.Fatal("translator role was lost")
			}
			if name == "googlebooks" && !strings.HasPrefix(*c.CoverURL, "https://") {
				t.Fatal("Google cover was not upgraded to HTTPS")
			}
			if name == "hardcover" && (c.Series == nil || c.Series.Index == nil || *c.Series.Index != 1.5) {
				t.Fatal("series index was lost")
			}
		})
	}
}

func TestProviderFallbackQuery(t *testing.T) {
	for _, name := range []string{"openlibrary", "googlebooks", "neodb", "hardcover"} {
		t.Run(name, func(t *testing.T) {
			p := testAdapter(t, name, func(w http.ResponseWriter, r *http.Request) {
				values := r.URL.Query()
				switch name {
				case "openlibrary":
					if values.Get("title") != "Test Library" || values.Get("author") != "Test Author" || values.Get("lang") != "en" {
						t.Error("missing fallback search fields")
					}
				case "googlebooks":
					if values.Get("q") != `intitle:"Test Library" inauthor:"Test Author"` || values.Get("langRestrict") != "en" {
						t.Error("missing Google fallback fields")
					}
				case "neodb":
					if values.Get("query") != "Test Library Test Author en" {
						t.Error("missing NeoDB fallback fields")
					}
				case "hardcover":
					var body struct {
						Variables map[string]string `json:"variables"`
					}
					if json.NewDecoder(r.Body).Decode(&body) != nil || body.Variables["query"] != "Test Library Test Author en" {
						t.Error("missing Hardcover fallback fields")
					}
				}
				_, _ = w.Write(fixture(t, name))
			})
			if _, err := p.Search(context.Background(), Query{Title: "Test Library", Author: "Test Author", Language: "en"}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestProviderFailuresAreBoundedAndRedacted(t *testing.T) {
	for _, name := range []string{"openlibrary", "googlebooks", "neodb", "hardcover"} {
		for _, test := range []struct {
			name   string
			status int
			body   string
			code   string
		}{
			{"malformed", 200, "{", "invalid_response"},
			{"null", 200, "null", "invalid_response"},
			{"missing-envelope", 200, "{}", "invalid_response"},
			{"oversized", 200, strings.Repeat("x", maxResponseBytes+1), "response_too_large"},
			{"rate-limit", 429, "fixture-credential", "rate_limited"},
			{"auth", 401, "fixture-credential", "authentication_failed"},
			{"upstream", 500, "fixture-credential", "upstream_error"},
		} {
			t.Run(name+"/"+test.name, func(t *testing.T) {
				p := testAdapter(t, name, func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(test.status)
					_, _ = w.Write([]byte(test.body))
				})
				_, err := p.Search(context.Background(), Query{ISBN: "9781234567897"})
				result := lookupFailure(err)
				if err == nil || result.Code != test.code || strings.Contains(result.Message+err.Error(), "fixture-credential") {
					t.Fatalf("failure = %v, %+v", err, result)
				}
			})
		}
	}
}

func TestProviderCredentialsAndCancellation(t *testing.T) {
	for _, name := range []string{"neodb", "hardcover"} {
		p := testAdapter(t, name, func(http.ResponseWriter, *http.Request) { t.Error("missing credentials made a network call") })
		p.token = ""
		if _, err := p.Search(context.Background(), Query{Title: "Test"}); lookupFailure(err).Code != "credentials_required" {
			t.Fatalf("missing credential = %v", err)
		}
	}
	p := testAdapter(t, "openlibrary", func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := p.Search(ctx, Query{Title: "Test"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout = %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("context cancellation was not honored")
	}
}

func TestGoogleOptionalKeyAndProviderGet(t *testing.T) {
	p := testAdapter(t, "googlebooks", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/books/v1/volumes/volume123" || r.URL.Query().Has("key") {
			t.Error("Get path or optional key is incorrect")
		}
		var data struct {
			Items []json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal(fixture(t, "googlebooks"), &data); err != nil {
			t.Error(err)
		}
		_, _ = w.Write(data.Items[0])
	})
	p.token = ""
	result, err := p.Get(context.Background(), "volume123")
	if err != nil || result.Reference != "volume123" {
		t.Fatalf("Get = %+v, %v", result, err)
	}
	for _, ref := range []string{"../../secret", "https://evil.test", "abc?key=secret"} {
		if _, err := p.Get(context.Background(), ref); !errors.Is(err, ErrInvalid) {
			t.Fatalf("unsafe ref %q = %v", ref, err)
		}
	}
}

func TestProviderGetAndHardcoverEncodedResults(t *testing.T) {
	for _, name := range []string{"openlibrary", "neodb", "hardcover"} {
		t.Run(name, func(t *testing.T) {
			ref := map[string]string{"openlibrary": "/works/OL123W", "neodb": "book123", "hardcover": "123"}[name]
			p := testAdapter(t, name, func(w http.ResponseWriter, r *http.Request) {
				switch name {
				case "openlibrary":
					if r.URL.Query().Get("q") != "key:"+ref {
						t.Error("Open Library record query is incorrect")
					}
					_, _ = w.Write(fixture(t, name))
				case "neodb":
					if r.URL.Path != "/api/book/"+ref {
						t.Error("NeoDB record path is incorrect")
					}
					var data struct {
						Data []json.RawMessage `json:"data"`
					}
					if err := json.Unmarshal(fixture(t, name), &data); err != nil {
						t.Error(err)
					}
					_, _ = w.Write(data.Data[0])
				case "hardcover":
					var request struct {
						Query     string `json:"query"`
						Variables struct {
							ID int `json:"id"`
						} `json:"variables"`
					}
					if json.NewDecoder(r.Body).Decode(&request) != nil || request.Variables.ID != 123 ||
						!strings.Contains(request.Query, "contributions { contribution author { name } }") {
						t.Error("Hardcover record query is incorrect")
					}
					_, _ = w.Write([]byte(`{"data":{"books":[{"id":123,"title":"Test Library","contributions":[{"contribution":"Author","author":{"name":"Test Author"}},{"contribution":"Translator","author":{"name":"Test Translator"}}]}]}}`))
				}
			})
			result, err := p.Get(context.Background(), ref)
			if err != nil || result.Reference != ref || result.Title != "Test Library" || len(result.Authors) == 0 {
				t.Fatalf("Get = %+v, %v", result, err)
			}
			if name == "hardcover" && (len(result.Authors) != 2 || result.Authors[1].Role != "translator") {
				t.Fatal("Hardcover contributor role was lost")
			}
		})
	}
	p := testAdapter(t, "hardcover", func(w http.ResponseWriter, _ *http.Request) {
		var data struct {
			Data struct {
				Search struct {
					Results json.RawMessage `json:"results"`
				} `json:"search"`
			} `json:"data"`
		}
		if err := json.Unmarshal(fixture(t, "hardcover"), &data); err != nil {
			t.Error(err)
		}
		if err := json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"search": map[string]any{
			"results": string(data.Data.Search.Results),
		}}}); err != nil {
			t.Error(err)
		}
	})
	result, err := p.Search(context.Background(), Query{Title: "Test Library"})
	if err != nil || len(result) != 1 {
		t.Fatalf("encoded search results = %+v, %v", result, err)
	}
}
