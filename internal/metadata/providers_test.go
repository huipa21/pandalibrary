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
	"reflect"
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

func fixtureHTML(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name+".html"))
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
					if r.URL.Path == "/works/OL123W.json" {
						_, _ = w.Write([]byte(`{"key":"/works/OL123W","description":{"type":"/type/text","value":"A work description."}}`))
						return
					}
					if r.URL.Path != "/search.json" || query.Get("isbn") != "9781234567897" || query.Get("limit") != "10" ||
						!strings.Contains(query.Get("fields"), "ratings_average,ratings_count") {
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
				c.Genres == nil || c.Moods == nil || c.Tags == nil || c.CoverURL == nil {
				t.Fatalf("normalization = %+v", c)
			}
			want := map[string]struct {
				rating      float64
				count       int64
				ids         int
				tags        []string
				genres      []string
				moods       []string
				seriesIndex float64
				seriesTotal int64
			}{
				"openlibrary": {4.31, 462, 2, []string{"Libraries", "Fiction"}, []string{}, []string{}, 2, 0},
				"googlebooks": {4.5, 12, 2, []string{}, []string{"Fiction", "Science Fiction", "Libraries"}, []string{}, -1, 0},
				"neodb":       {4.2, 25, 4, []string{"Libraries"}, []string{}, []string{}, -1, 0},
				"hardcover":   {4.12, 50, 2, []string{"Libraries"}, []string{"Reference", "Fantasy"}, []string{"Reflective"}, 1.5, 3},
			}[name]
			if c.Rating == nil || *c.Rating != want.rating || c.RatingCount == nil || *c.RatingCount != want.count {
				t.Fatalf("rating = %v/%v", c.Rating, c.RatingCount)
			}
			if len(c.Identifiers) != want.ids || !reflect.DeepEqual(c.Tags, want.tags) ||
				!reflect.DeepEqual(c.Genres, want.genres) || !reflect.DeepEqual(c.Moods, want.moods) {
				t.Fatalf("terms = ids %+v tags %q genres %q moods %q", c.Identifiers, c.Tags, c.Genres, c.Moods)
			}
			if want.seriesIndex >= 0 && (c.Series == nil || c.Series.Name != "Library Series" || c.Series.Index == nil || *c.Series.Index != want.seriesIndex) {
				t.Fatalf("series = %+v", c.Series)
			}
			if want.seriesTotal > 0 && (c.Series.Total == nil || *c.Series.Total != want.seriesTotal) {
				t.Fatalf("series total = %+v", c.Series)
			}
			if name == "openlibrary" && (c.Description == nil || *c.Description != "A work description.") {
				t.Fatalf("Open Library work description = %v", c.Description)
			}
			if name == "neodb" && (c.Identifiers[1] != Identifier{Scheme: "douban", Value: "1234567"} ||
				c.Identifiers[2] != Identifier{Scheme: "goodreads", Value: "39776179"}) {
				t.Fatalf("NeoDB external identifiers = %+v", c.Identifiers)
			}
			if name == "googlebooks" && (c.ContentRating == nil || *c.ContentRating != "everyone" ||
				*c.CoverURL != "https://books.google.com/books/content?id=volume123&zoom=3") {
				t.Fatalf("Google maturity/cover = %v %s", c.ContentRating, *c.CoverURL)
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
					if strings.HasPrefix(r.URL.Path, "/works/") {
						break
					}
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

func TestMainlandProviderFixtures(t *testing.T) {
	t.Run("crossref", func(t *testing.T) {
		p := testAdapter(t, "crossref", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/works" || r.URL.Query().Get("filter") != "isbn:9781234567897" {
				t.Errorf("Crossref request = %s", r.URL)
			}
			_, _ = w.Write(fixture(t, "crossref"))
		})
		result, err := p.Search(context.Background(), Query{ISBN: "9781234567897"})
		if err != nil || len(result) != 1 {
			t.Fatalf("Crossref search = %+v, %v", result, err)
		}
		c := result[0]
		if c.Provider != "crossref" || c.Reference != "10.1234/test.book" || c.Title != "Test Library" ||
			c.Subtitle == nil || *c.Subtitle != "A fixture" || c.Publisher == nil || *c.Publisher != "Test Press" ||
			c.PublishedDate == nil || *c.PublishedDate != "2024-02-29" || len(c.Authors) != 2 || c.Authors[0].Role != "author" ||
			!reflect.DeepEqual(c.Identifiers, []Identifier{{Scheme: "isbn13", Value: "9781234567897"}, {Scheme: "doi", Value: "10.1234/test.book"}}) {
			t.Fatalf("Crossref normalization = %+v", c)
		}
	})

	t.Run("openbd", func(t *testing.T) {
		p := testAdapter(t, "openbd", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/get" || r.URL.Query().Get("isbn") != "9781234567897" {
				t.Errorf("OpenBD request = %s", r.URL)
			}
			_, _ = w.Write(fixture(t, "openbd"))
		})
		result, err := p.Search(context.Background(), Query{ISBN: "9781234567897"})
		if err != nil || len(result) != 1 {
			t.Fatalf("OpenBD search = %+v, %v", result, err)
		}
		c := result[0]
		if c.Provider != "openbd" || c.Reference != "9781234567897" || c.Title != "Test Library" ||
			c.Publisher == nil || *c.Publisher != "Test Press" || c.PublishedDate == nil || *c.PublishedDate != "2024-02" ||
			c.Series == nil || c.Series.Name != "Library Series" || c.CoverURL == nil || len(c.Authors) != 1 || c.Authors[0].Name != "Test Author" {
			t.Fatalf("OpenBD normalization = %+v", c)
		}
	})

	t.Run("douban", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join("testdata", "douban.html"))
		if err != nil {
			t.Fatal(err)
		}
		p := testAdapter(t, "douban", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/isbn/9781234567897/" && r.URL.Path != "/subject/1234567/" {
				t.Errorf("Douban request = %s", r.URL)
			}
			_, _ = w.Write(data)
		})
		result, err := p.Search(context.Background(), Query{ISBN: "9781234567897"})
		if err != nil || len(result) != 1 {
			t.Fatalf("Douban search = %+v, %v", result, err)
		}
		c := result[0]
		if c.Provider != "douban" || c.Reference != "1234567" || c.Title != "Test Library" ||
			c.Subtitle == nil || *c.Subtitle != "A fixture" || c.Publisher == nil || *c.Publisher != "Test Press" ||
			c.PublishedDate == nil || *c.PublishedDate != "2024-02-29" || c.PageCount == nil || *c.PageCount != 321 ||
			c.Series == nil || c.Series.Name != "Library Series" || c.Rating == nil || *c.Rating != 4.55 ||
			c.RatingCount == nil || *c.RatingCount != 3991 || len(c.Authors) != 2 || c.Authors[1].Role != "translator" {
			t.Fatalf("Douban normalization = %+v", c)
		}
		got, err := p.Get(context.Background(), "1234567")
		if err != nil || got.Reference != "1234567" {
			t.Fatalf("Douban get = %+v, %v", got, err)
		}
	})

	t.Run("douban-mobile", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join("testdata", "douban-mobile.html"))
		if err != nil {
			t.Fatal(err)
		}
		p := testAdapter(t, "douban", func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write(data)
		})
		result, err := p.Search(context.Background(), Query{ISBN: "9787530221532"})
		if err != nil || len(result) != 1 {
			t.Fatalf("Douban mobile search = %+v, %v", result, err)
		}
		c := result[0]
		if c.Reference != "35481711" || c.Title != "活着" || c.Publisher == nil || *c.Publisher != "北京十月文艺出版社" ||
			c.PublishedDate == nil || *c.PublishedDate != "2021-07" || c.Rating == nil || *c.Rating != 4.7 ||
			c.RatingCount == nil || *c.RatingCount != 3379 || len(c.Authors) != 1 || c.Authors[0].Name != "余华" ||
			!reflect.DeepEqual(c.Identifiers, []Identifier{{Scheme: "isbn13", Value: "9787530221532"}, {Scheme: "douban", Value: "35481711"}}) {
			t.Fatalf("Douban mobile normalization = %+v", c)
		}
	})

	t.Run("douban-json-search", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join("testdata", "douban-search.html"))
		if err != nil {
			t.Fatal(err)
		}
		ids, err := parseDoubanSearch(data)
		if err != nil || !reflect.DeepEqual(ids, []string{"35481711", "4913064", "27064488"}) {
			t.Fatalf("Douban JSON search = %v, %v", ids, err)
		}
	})
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
					if r.URL.Path == "/search.json" && r.URL.Query().Get("q") != "key:"+ref {
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
						!strings.Contains(request.Query, "contributions { contribution author { name } }") ||
						!strings.Contains(request.Query, "rating ratings_count cached_tags") {
						t.Error("Hardcover record query is incorrect")
					}
					_, _ = w.Write([]byte(`{"data":{"books":[{"id":123,"title":"Test Library","rating":3.5,"ratings_count":7,` +
						`"cached_tags":{"Genre":[{"tag":"Fantasy","count":3}],"Mood":[{"tag":"Dark"}],"Tag":["Magic"],"Content Warning":"bad shape"},` +
						`"featured_series":{"position":2,"series":{"name":"Get Series","books_count":4}},` +
						`"contributions":[{"contribution":"Author","author":{"name":"Test Author"}},{"contribution":"Translator","author":{"name":"Test Translator"}}]}]}}`))
				}
			})
			result, err := p.Get(context.Background(), ref)
			if err != nil || result.Reference != ref || result.Title != "Test Library" || len(result.Authors) == 0 {
				t.Fatalf("Get = %+v, %v", result, err)
			}
			if name == "hardcover" && (len(result.Authors) != 2 || result.Authors[1].Role != "translator") {
				t.Fatal("Hardcover contributor role was lost")
			}
			if name == "hardcover" && (!reflect.DeepEqual(result.Genres, []string{"Fantasy"}) || !reflect.DeepEqual(result.Moods, []string{"Dark"}) ||
				!reflect.DeepEqual(result.Tags, []string{"Magic"}) || result.Rating == nil || *result.Rating != 3.5 ||
				result.Series == nil || result.Series.Name != "Get Series" || *result.Series.Index != 2 || *result.Series.Total != 4) {
				t.Fatalf("Hardcover cached tags/series = %+v %+v", result, result.Series)
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

func TestGoodreadsTokenlessAutocompleteAndPage(t *testing.T) {
	t.Run("autocomplete-preview", func(t *testing.T) {
		p := testAdapter(t, "goodreads", func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("User-Agent") != browserUserAgent || r.Header.Get("Accept-Language") == "" {
				t.Error("Goodreads request did not use browser headers")
			}
			switch r.URL.Path {
			case "/book/auto_complete":
				if r.URL.Query().Get("q") != "Test Library Test Author" {
					t.Errorf("autocomplete query = %q", r.URL.Query().Get("q"))
				}
				_, _ = w.Write(fixture(t, "goodreads-autocomplete"))
			default:
				http.NotFound(w, r)
			}
		})
		result, err := p.Search(context.Background(), Query{Title: "Test Library", Author: "Test Author"})
		if err != nil || len(result) != 1 {
			t.Fatalf("Goodreads autocomplete = %+v, %v", result, err)
		}
		c := result[0]
		if c.Provider != "goodreads" || c.Reference != "12345" || c.Title != "Test Library" || c.Subtitle != nil ||
			len(c.Authors) != 1 || c.Authors[0].Name != "Test Author" ||
			c.PageCount == nil || *c.PageCount != 321 || c.Rating == nil || *c.Rating != 4.31 ||
			c.RatingCount == nil || *c.RatingCount != 1462 || c.CoverURL == nil || strings.Contains(*c.CoverURL, "_SX50_") {
			t.Fatalf("Goodreads preview = %+v", c)
		}
	})

	t.Run("isbn-page", func(t *testing.T) {
		p := testAdapter(t, "goodreads", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/book/isbn/9781234567897" {
				t.Errorf("Goodreads ISBN path = %s", r.URL.Path)
			}
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write(fixtureHTML(t, "goodreads"))
		})
		result, err := p.Search(context.Background(), Query{ISBN: "9781234567897"})
		if err != nil || len(result) != 1 {
			t.Fatalf("Goodreads ISBN = %+v, %v", result, err)
		}
		c := result[0]
		if c.Provider != "goodreads" || c.Reference != "12345" || c.Title != "Test Library" || c.Subtitle == nil ||
			*c.Subtitle != "A Fixture" || len(c.Authors) != 1 || c.PublishedDate == nil || *c.PublishedDate != "2024-02-29" ||
			c.PageCount == nil || *c.PageCount != 321 || c.Rating == nil || *c.Rating != 4.31 ||
			c.RatingCount == nil || *c.RatingCount != 462 || c.Description == nil || *c.Description != "A fixture description." {
			t.Fatalf("Goodreads page = %+v", c)
		}
		if len(c.Identifiers) != 2 || c.Identifiers[0] != (Identifier{Scheme: "isbn13", Value: "9781234567897"}) ||
			c.Identifiers[1] != (Identifier{Scheme: "goodreads", Value: "12345"}) {
			t.Fatalf("Goodreads identifiers = %+v", c.Identifiers)
		}
	})
}

func TestAmazonTokenlessSearchAndDetail(t *testing.T) {
	p := testAdapter(t, "amazon", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != browserUserAgent || r.Header.Get("Accept-Language") == "" {
			t.Error("Amazon request did not use browser headers")
		}
		switch r.URL.Path {
		case "/s":
			if r.URL.Query().Get("k") != "9781234567897" {
				t.Errorf("Amazon search query = %q", r.URL.Query().Get("k"))
			}
			_, _ = w.Write(fixtureHTML(t, "amazon-search"))
		case "/dp/B08TEST123":
			_, _ = w.Write(fixtureHTML(t, "amazon"))
		default:
			http.NotFound(w, r)
		}
	})
	result, err := p.Search(context.Background(), Query{ISBN: "9781234567897"})
	if err != nil || len(result) != 1 {
		t.Fatalf("Amazon search = %+v, %v", result, err)
	}
	c := result[0]
	if c.Provider != "amazon" || c.Reference != "B08TEST123" || c.Title != "Test Library" || c.Subtitle == nil ||
		*c.Subtitle != "A Fixture" || len(c.Authors) != 1 || c.Authors[0].Name != "Test Author" ||
		c.Publisher == nil || *c.Publisher != "Test Press" || c.PublishedDate == nil || *c.PublishedDate != "2024-02-29" ||
		c.PageCount == nil || *c.PageCount != 321 || c.Rating == nil || *c.Rating != 4.5 ||
		c.RatingCount == nil || *c.RatingCount != 1234 || c.Description == nil || *c.Description != "A fixture description." ||
		!reflect.DeepEqual(c.Genres, []string{"Computers"}) {
		t.Fatalf("Amazon candidate = %+v", c)
	}
	if len(c.Identifiers) != 3 || c.Identifiers[0] != (Identifier{Scheme: "isbn10", Value: "123456789X"}) ||
		c.Identifiers[1] != (Identifier{Scheme: "isbn13", Value: "9781234567897"}) ||
		c.Identifiers[2] != (Identifier{Scheme: "asin", Value: "B08TEST123"}) {
		t.Fatalf("Amazon identifiers = %+v", c.Identifiers)
	}
	detail, err := p.Get(context.Background(), "B08TEST123")
	if err != nil || detail.Title != "Test Library" || detail.Reference != "B08TEST123" {
		t.Fatalf("Amazon Get = %+v, %v", detail, err)
	}
}

func TestAmazonChallengeIsRejected(t *testing.T) {
	p := testAdapter(t, "amazon", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`<html><body><h1>Robot Check</h1></body></html>`))
	})
	if _, err := p.Search(context.Background(), Query{ISBN: "9781234567897"}); lookupFailure(err).Code != "upstream_error" {
		t.Fatalf("Amazon challenge = %v", err)
	}
}
