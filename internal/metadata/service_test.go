package metadata

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
	"pandalibrary/internal/db/sqlc"
)

var administrator = catalog.Viewer{UserID: 1, IsAdmin: true}

type serviceFixture struct {
	service *Service
	db      *db.DB
	books   *catalog.Service
}

func newServiceFixture(t *testing.T) serviceFixture {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	path := filepath.Join(root, "metadata.db")
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
	store, err := blobstore.New(root)
	if err != nil {
		t.Fatal(err)
	}
	books, err := catalog.NewService(database.Writer, database.Reader, store)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(database.Writer, database.Reader, books)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Writer.ExecContext(ctx, `
		INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
		  (1, 'admin', 'test', 'admin', 1, 1), (2, 'reader', 'test', 'user', 1, 1);
		INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (10, 'Main', 'main', 1, 1);
		INSERT INTO books (id, library_id, title, sort_title, subtitle, language, created_at, updated_at) VALUES
		  (101, 10, 'Original Title', 'original title', 'Original Subtitle', 'en', 1, 1),
		  (102, 10, 'Hidden', 'hidden', NULL, NULL, 1, 1);
		INSERT INTO authors (id, name, sort_name, created_at) VALUES (1, 'Original Author', 'original author', 1);
		INSERT INTO book_authors (book_id, author_id, role, position) VALUES (101, 1, 'author', 0);
		INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (1, 102, 1, 1);
		INSERT INTO book_field_sources (book_id, field, source, source_ref, chosen_by, chosen_at) VALUES
		  (101, 'title', 'file', 'original.epub', 1, 1), (101, 'subtitle', 'manual', NULL, 1, 2);
	`); err != nil {
		t.Fatal(err)
	}
	return serviceFixture{service: service, db: database, books: books}
}

type stubProvider struct {
	name   string
	search func(context.Context, Query) ([]Candidate, error)
}

func (p stubProvider) Name() string { return p.name }
func (p stubProvider) Search(ctx context.Context, q Query) ([]Candidate, error) {
	return p.search(ctx, q)
}
func (p stubProvider) Get(context.Context, string) (*Candidate, error) {
	return nil, errors.New("unexpected Get: apply must not refetch")
}

func stubCandidate(name string) Candidate {
	return Candidate{Provider: name, Reference: "record123", Title: "Chosen Title",
		Subtitle: text("Chosen Subtitle"), Description: text("Chosen Description"),
		Publisher: text("Chosen Press"), PublishedDate: text("2024-02-29"), Language: text("en"),
		PageCount: pages(123), Series: &Series{Name: "Chosen Series"},
		Authors: []Person{{Name: "Chosen Author", Role: "author"}, {Name: "Chosen Translator", Role: "translator"}},
		Tags:    []string{"Chosen Tag"}, Identifiers: []Identifier{{Scheme: name, Value: "record123"}}}
}

func providerResult(result LookupResponse, name string) ProviderResult {
	for _, provider := range result.Providers {
		if provider.Provider == name {
			return provider
		}
	}
	return ProviderResult{}
}

func installStub(s *Service, search func(string, context.Context, Query) ([]Candidate, error)) {
	s.factory = func(name string, _ *string, _ string) (Provider, error) {
		return stubProvider{name: name, search: func(ctx context.Context, q Query) ([]Candidate, error) {
			return search(name, ctx, q)
		}}, nil
	}
	for _, bucket := range s.limits {
		bucket.interval = time.Millisecond
	}
}

func providerPatch(t *testing.T, data string) ProviderPatch {
	t.Helper()
	var patch ProviderPatch
	if err := json.Unmarshal([]byte(data), &patch); err != nil {
		t.Fatal(err)
	}
	return patch
}

func TestLookupParallelPartialFailuresAndCacheTTLs(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	started := make(chan string, 2)
	release := make(chan struct{})
	var calls atomic.Int64
	installStub(f.service, func(name string, ctx context.Context, q Query) ([]Candidate, error) {
		calls.Add(1)
		if q.Title != "Original Title" || q.Author != "Original Author" || q.Language != "en" || q.ISBN != "" {
			t.Errorf("book query = %+v", q)
		}
		started <- name
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
		}
		if name == "googlebooks" {
			return nil, failure("rate_limited")
		}
		return []Candidate{stubCandidate(name)}, nil
	})
	go func() {
		<-started
		<-started
		close(release)
	}()
	start := time.Now()
	result, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil || len(result.Providers) != 4 || time.Since(start) > 2*time.Second {
		t.Fatalf("parallel lookup = %+v, %v", result, err)
	}
	openlibrary, googlebooks := providerResult(result, "openlibrary"), providerResult(result, "googlebooks")
	if openlibrary.Provider != "openlibrary" || len(openlibrary.Candidates) != 1 ||
		googlebooks.Error == nil || googlebooks.Error.Code != "rate_limited" {
		t.Fatalf("partial results = %+v", result)
	}
	for _, test := range []struct {
		provider string
		status   int64
		ttl      time.Duration
	}{
		{"openlibrary", 200, 30 * 24 * time.Hour},
		{"googlebooks", 503, 10 * time.Minute},
	} {
		row, err := sqlc.New(f.db.Reader).MetadataGetCache(ctx, sqlc.MetadataGetCacheParams{Provider: test.provider, RequestKey: result.RequestKey})
		if err != nil || row.Status != test.status || row.SchemaVersion != cacheSchema ||
			time.Duration(row.ExpiresAt-row.FetchedAt)*time.Millisecond != test.ttl {
			t.Fatalf("cache row = %+v, %v", row, err)
		}
	}
	if _, err := f.service.Lookup(ctx, administrator, 101); err != nil || calls.Load() != 4 {
		t.Fatalf("cache was not reused: calls=%d err=%v", calls.Load(), err)
	}
}

func TestCacheExpirySchemaNegativeAndFailures(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	now := time.Now()
	f.service.now = func() time.Time { return now }
	var calls atomic.Int64
	installStub(f.service, func(name string, _ context.Context, _ Query) ([]Candidate, error) {
		calls.Add(1)
		if name == "googlebooks" {
			return []Candidate{}, nil
		}
		return []Candidate{stubCandidate(name)}, nil
	})
	result, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil {
		t.Fatal(err)
	}
	row, err := sqlc.New(f.db.Reader).MetadataGetCache(ctx, sqlc.MetadataGetCacheParams{Provider: "googlebooks", RequestKey: result.RequestKey})
	if err != nil || row.Status != 404 || row.ExpiresAt-row.FetchedAt != (7*24*time.Hour).Milliseconds() {
		t.Fatalf("negative TTL = %+v %v", row, err)
	}
	now = now.Add(8 * 24 * time.Hour)
	if _, err := f.service.Lookup(ctx, administrator, 101); err != nil || calls.Load() != 5 {
		t.Fatalf("negative expiry calls=%d err=%v", calls.Load(), err)
	}
	if _, err := f.db.Writer.ExecContext(ctx, `UPDATE metadata_cache SET schema_version = 999 WHERE provider = 'openlibrary'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Lookup(ctx, administrator, 101); err != nil || calls.Load() != 6 {
		t.Fatalf("schema invalidation calls=%d err=%v", calls.Load(), err)
	}
	if _, err := f.db.Writer.ExecContext(ctx, `UPDATE metadata_cache SET response = '{}' WHERE provider = 'openlibrary'`); err != nil {
		t.Fatal(err)
	}
	corrupt, err := f.service.Lookup(ctx, administrator, 101)
	openlibrary := providerResult(corrupt, "openlibrary")
	if err != nil || openlibrary.Error == nil || openlibrary.Error.Code != "cache_read_failed" {
		t.Fatalf("corrupt cache not explicit: %+v %v", corrupt, err)
	}
	if _, err := f.db.Writer.ExecContext(ctx, `
		DELETE FROM metadata_cache;
		CREATE TRIGGER fail_metadata_cache BEFORE INSERT ON metadata_cache BEGIN SELECT RAISE(ABORT, 'fixture cache failure'); END;
	`); err != nil {
		t.Fatal(err)
	}
	failed, err := f.service.Lookup(ctx, administrator, 101)
	openlibrary = providerResult(failed, "openlibrary")
	if err != nil || openlibrary.Error == nil || openlibrary.Error.Code != "cache_write_failed" {
		t.Fatalf("cache write failure = %+v %v", failed, err)
	}
}

func TestTokenlessProvidersEnabledByDefault(t *testing.T) {
	f := newServiceFixture(t)
	list, err := f.service.ListProviders(context.Background(), administrator)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, provider := range list {
		switch provider.Provider {
		case "amazon", "goodreads":
			found[provider.Provider] = true
			if !provider.Enabled || provider.HasToken || provider.BaseURL != nil {
				t.Errorf("default %s = %+v", provider.Provider, provider)
			}
		}
	}
	if !found["amazon"] || !found["goodreads"] {
		t.Fatalf("tokenless defaults missing: %+v", list)
	}
}

func TestProviderConfigurationValidationRedactionAndInvalidation(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	for _, test := range []struct {
		name string
		body string
	}{
		{"neodb", `{"enabled":true}`},
		{"hardcover", `{"enabled":true}`},
		{"neodb", `{"base_url":"file:///etc/passwd"}`},
		{"neodb", `{"base_url":"https://user:pass@neodb.social"}`},
		{"neodb", `{"base_url":"https://neodb.social?token=secret"}`},
		{"neodb", `{"base_url":"https://neodb.social/api"}`},
		{"googlebooks", `{"base_url":"https://evil.example"}`},
		{"openlibrary", `{"api_token":"not-supported"}`},
		{"crossref", `{"api_token":"not-supported"}`},
		{"openbd", `{"api_token":"not-supported"}`},
		{"douban", `{"api_token":"not-supported"}`},
		{"amazon", `{"api_token":"not-supported"}`},
		{"goodreads", `{"api_token":"not-supported"}`},
		{"amazon", `{"base_url":"https://evil.example"}`},
		{"goodreads", `{"base_url":"https://evil.example"}`},
		{"googlebooks", `{"api_token":"bad\r\nheader"}`},
		{"googlebooks", `{"priority":-1}`},
		{"googlebooks", `{"enabled":null}`},
		{"googlebooks", `{}`},
	} {
		if _, err := f.service.UpdateProvider(ctx, administrator, test.name, providerPatch(t, test.body)); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s %s = %v", test.name, test.body, err)
		}
	}
	result, err := f.service.UpdateProvider(ctx, administrator, "neodb", providerPatch(t,
		`{"enabled":true,"api_token":"write-only-fixture-token","base_url":"http://127.0.0.1:8080/","priority":5}`))
	if err != nil || !result.Enabled || !result.HasToken || result.Priority != 5 || result.BaseURL == nil {
		t.Fatalf("configure NeoDB = %+v, %v", result, err)
	}
	list, err := f.service.ListProviders(ctx, administrator)
	data, marshalErr := json.Marshal(list)
	hasNeoDB := false
	for _, item := range list {
		hasNeoDB = hasNeoDB || item.Provider == "neodb"
	}
	if err != nil || marshalErr != nil || strings.Contains(string(data), "write-only-fixture-token") ||
		strings.Contains(string(data), "api_token") || !hasNeoDB {
		t.Fatalf("redacted provider list = %s %v", data, err)
	}
	if _, err := f.service.UpdateProvider(ctx, administrator, "neodb", providerPatch(t, `{"api_token":null}`)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("enabled credentials cleared: %v", err)
	}
	installStub(f.service, func(name string, _ context.Context, _ Query) ([]Candidate, error) {
		return []Candidate{stubCandidate(name)}, nil
	})
	lookup, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.UpdateProvider(ctx, administrator, "neodb", providerPatch(t, `{"priority":6}`)); err != nil {
		t.Fatal(err)
	}
	_, hit, err := f.service.readCache(ctx, "neodb", lookup.RequestKey)
	if hit || err != nil {
		t.Fatalf("configuration did not invalidate cache: %v %v", hit, err)
	}
	disabled, err := f.service.UpdateProvider(ctx, administrator, "neodb", providerPatch(t, `{"enabled":false,"api_token":null}`))
	if err != nil || disabled.HasToken || disabled.Enabled {
		t.Fatalf("credential removal = %+v %v", disabled, err)
	}
}

func TestApplyExplicitFieldsProvenanceVisibilityAndRollback(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	installStub(f.service, func(name string, _ context.Context, _ Query) ([]Candidate, error) {
		return []Candidate{stubCandidate(name)}, nil
	})
	response, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil {
		t.Fatal(err)
	}
	selection := Selection{Provider: "openlibrary", Reference: "record123"}
	request := ApplyRequest{RequestKey: response.RequestKey, Fields: map[string]Selection{"title": selection}}
	book, err := f.service.Apply(ctx, administrator, 101, request)
	if err != nil || book.Title != "Chosen Title" || book.Subtitle == nil || *book.Subtitle != "Original Subtitle" ||
		len(book.Authors) != 1 || book.Authors[0].Name != "Original Author" {
		t.Fatalf("explicit apply = %+v, %v", book, err)
	}
	if len(book.FieldSources) != 2 {
		t.Fatalf("sources = %+v", book.FieldSources)
	}
	for _, source := range book.FieldSources {
		if source.Field == "title" && (source.Source != "openlibrary" || source.SourceRef == nil ||
			*source.SourceRef != "record123" || source.ChosenBy == nil || *source.ChosenBy != 1 || source.ChosenAt.UnixMilli() <= 2) {
			t.Fatalf("provider source = %+v", source)
		}
		if source.Field == "subtitle" && (source.Source != "manual" || source.ChosenAt.UnixMilli() != 2) {
			t.Fatalf("unchanged source = %+v", source)
		}
	}
	var indexedTitle string
	if err := f.db.Reader.QueryRowContext(ctx, `SELECT title FROM books_fts WHERE rowid = 101`).Scan(&indexedTitle); err != nil || indexedTitle != book.Title {
		t.Fatalf("search index = %s %v", indexedTitle, err)
	}
	for _, field := range []string{"subtitle", "description", "publisher", "published_date", "language", "page_count", "authors", "tags", "identifiers", "series"} {
		request.Fields = map[string]Selection{field: selection}
		if _, err := f.service.Apply(ctx, administrator, 101, request); err != nil {
			t.Fatalf("apply %s: %v", field, err)
		}
	}
	request.Fields = map[string]Selection{"library_id": selection}
	if _, err := f.service.Apply(ctx, administrator, 101, request); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown field = %v", err)
	}
	request.Fields = map[string]Selection{"title": {Provider: "openlibrary", Reference: "forged"}}
	if _, err := f.service.Apply(ctx, administrator, 101, request); !errors.Is(err, ErrConflict) {
		t.Fatalf("forged reference = %v", err)
	}
	reader := catalog.Viewer{UserID: 2}
	if _, err := f.service.Apply(ctx, reader, 101, request); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatalf("non-admin apply = %v", err)
	}
	if _, err := f.service.Lookup(ctx, administrator, 102); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("hidden lookup = %v", err)
	}
	if _, err := f.service.Apply(ctx, administrator, 102, request); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("hidden apply = %v", err)
	}
	if _, err := f.service.Apply(ctx, administrator, 999, request); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("missing apply = %v", err)
	}
	if _, err := f.db.Writer.ExecContext(ctx, `
		UPDATE books SET title = 'Before rollback' WHERE id = 101;
		CREATE TRIGGER fail_provider_source BEFORE UPDATE ON book_field_sources
		WHEN NEW.source = 'openlibrary' BEGIN SELECT RAISE(ABORT, 'fixture source failure'); END;
	`); err != nil {
		t.Fatal(err)
	}
	request.Fields = map[string]Selection{"title": selection}
	if _, err := f.service.Apply(ctx, administrator, 101, request); err == nil {
		t.Fatal("provenance failure should roll back the book")
	}
	after, err := f.books.GetBook(ctx, administrator, 101)
	if err != nil || after.Title != "Before rollback" {
		t.Fatalf("atomic rollback = %+v %v", after, err)
	}
}

func TestSelectionExpirySchemaBindingAndPermissions(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	installStub(f.service, func(name string, _ context.Context, _ Query) ([]Candidate, error) {
		return []Candidate{stubCandidate(name)}, nil
	})
	result, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil {
		t.Fatal(err)
	}
	request := ApplyRequest{RequestKey: result.RequestKey, Fields: map[string]Selection{
		"title": {Provider: "openlibrary", Reference: "record123"},
	}}
	for _, statement := range []string{
		`UPDATE metadata_cache SET expires_at = 0`,
		`UPDATE metadata_cache SET expires_at = 9999999999999, schema_version = 999`,
	} {
		if _, err := f.db.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
		if _, err := f.service.Apply(ctx, administrator, 101, request); !errors.Is(err, ErrConflict) {
			t.Fatalf("expired/schema selection = %v", err)
		}
	}
	request.RequestKey = requestKey(102, Query{Title: "Hidden"})
	if _, err := f.service.Apply(ctx, administrator, 101, request); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cross-book selection = %v", err)
	}
	reader := catalog.Viewer{UserID: 2}
	if _, err := f.service.Lookup(ctx, reader, 101); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatal("non-admin lookup allowed")
	}
	if _, err := f.service.ListProviders(ctx, reader); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatal("non-admin configuration allowed")
	}
	if _, err := f.service.UpdateProvider(ctx, reader, "googlebooks", ProviderPatch{}); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatal("non-admin update allowed")
	}
}

func TestApplyMixedFieldsProvenanceAndIndex(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	installStub(f.service, func(name string, _ context.Context, _ Query) ([]Candidate, error) {
		return []Candidate{stubCandidate(name)}, nil
	})
	lookup, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil {
		t.Fatal(err)
	}
	var request ApplyRequest
	if err := json.Unmarshal([]byte(`{
			"fields":{"title":{"provider":"openlibrary","reference":"record123"}},
			"patch":{"subtitle":null,"description":"Manual description","language":"zh",
				"publisher":"Manual press","published_date":"2025-01","page_count":null,
				"series":{"name":"Manual series","index":2.5},
				"authors":[{"name":"Manual author","role":"editor"}],
				"tags":[],"identifiers":[{"scheme":"isbn13","value":"978123"}]}
		}`), &request); err != nil {
		t.Fatal(err)
	}
	request.RequestKey = lookup.RequestKey
	book, err := f.service.Apply(ctx, administrator, 101, request)
	if err != nil || book.Title != "Chosen Title" || book.Subtitle != nil ||
		book.Description == nil || *book.Description != "Manual description" ||
		book.Language == nil || *book.Language != "zh" || book.Publisher == nil || *book.Publisher != "Manual press" ||
		book.PublishedDate == nil || *book.PublishedDate != "2025-01" || book.PageCount != nil ||
		book.Series == nil || book.Series.Name != "Manual series" || book.Series.Index == nil || *book.Series.Index != 2.5 ||
		len(book.Authors) != 1 || book.Authors[0].Name != "Manual author" || book.Authors[0].Role != "editor" ||
		len(book.Tags) != 0 || len(book.Identifiers) != 1 || book.Identifiers[0].Value != "978123" {
		t.Fatalf("mixed apply = %+v, %v", book, err)
	}
	if len(book.FieldSources) != 11 {
		t.Fatalf("mixed sources = %+v", book.FieldSources)
	}
	for _, source := range book.FieldSources {
		if source.ChosenBy == nil || *source.ChosenBy != administrator.UserID || source.ChosenAt.UnixMilli() <= 2 {
			t.Fatalf("chooser = %+v", source)
		}
		if source.Field == "title" {
			if source.Source != "openlibrary" || source.SourceRef == nil || *source.SourceRef != "record123" {
				t.Fatalf("provider source = %+v", source)
			}
		} else if source.Source != "manual" || source.SourceRef != nil {
			t.Fatalf("manual source = %+v", source)
		}
	}
	var title, description, authors, publisher string
	if err := f.db.Reader.QueryRowContext(ctx, `
			SELECT title, description, authors, publisher FROM books_fts WHERE rowid = 101`).
		Scan(&title, &description, &authors, &publisher); err != nil ||
		title != book.Title || description != *book.Description || authors != "Manual author" || publisher != "Manual press" {
		t.Fatalf("mixed index = %q %q %q %q, %v", title, description, authors, publisher, err)
	}
	request.Fields = map[string]Selection{"publisher": {Provider: "openlibrary", Reference: "record123"}}
	request.Patch = catalog.BookPatch{Title: catalog.Optional[string]{Set: true, Value: text("Manual title")}}
	book, err = f.service.Apply(ctx, administrator, 101, request)
	if err != nil || book.Title != "Manual title" || book.Publisher == nil || *book.Publisher != "Chosen Press" {
		t.Fatalf("manual title = %+v, %v", book, err)
	}
	for _, source := range book.FieldSources {
		if source.Field == "title" && (source.Source != "manual" || source.SourceRef != nil) {
			t.Fatalf("manual edit did not clear provider reference: %+v", source)
		}
		if source.Field == "publisher" && (source.Source != "openlibrary" || source.SourceRef == nil || *source.SourceRef != "record123") {
			t.Fatalf("selected field did not replace manual provenance: %+v", source)
		}
	}
}

func TestApplyMixedRejectionAndRollback(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	installStub(f.service, func(name string, _ context.Context, _ Query) ([]Candidate, error) {
		return []Candidate{stubCandidate(name)}, nil
	})
	lookup, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil {
		t.Fatal(err)
	}
	before, err := f.books.UpdateBook(ctx, administrator, 101, catalog.BookPatch{
		Description: catalog.Optional[string]{Set: true, Value: text("Before description")},
		Tags:        catalog.Optional[[]string]{Set: true, Value: &[]string{"Before tag"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	selection := Selection{Provider: "openlibrary", Reference: "record123"}
	base := ApplyRequest{RequestKey: lookup.RequestKey, Fields: map[string]Selection{"title": selection},
		Patch: catalog.BookPatch{
			Subtitle:    catalog.Optional[string]{Set: true},
			Description: catalog.Optional[string]{Set: true, Value: text("After description")},
			Tags:        catalog.Optional[[]string]{Set: true, Value: &[]string{"After tag"}},
		}}
	assertUnchanged := func(t *testing.T) {
		t.Helper()
		after, err := f.books.GetBook(ctx, administrator, 101)
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatalf("failed mixed save mutated book: before=%+v after=%+v err=%v", before, after, err)
		}
		var title, description, tags string
		if err := f.db.Reader.QueryRowContext(ctx, `
				SELECT title, description, tags FROM books_fts WHERE rowid = 101`).
			Scan(&title, &description, &tags); err != nil ||
			title != before.Title || description != *before.Description || tags != "Before tag" {
			t.Fatalf("failed mixed save mutated index: %q %q %q, %v", title, description, tags, err)
		}
	}
	for _, test := range []struct {
		name   string
		change func(*ApplyRequest)
		want   error
	}{
		{"empty selections", func(r *ApplyRequest) { r.Fields = nil }, ErrInvalid},
		{"unknown field", func(r *ApplyRequest) { r.Fields = map[string]Selection{"unknown": selection} }, ErrInvalid},
		{"invalid selection", func(r *ApplyRequest) { r.Fields = map[string]Selection{"title": {}} }, ErrInvalid},
		{"forged reference", func(r *ApplyRequest) {
			r.Fields = map[string]Selection{"title": {Provider: selection.Provider, Reference: "forged"}}
		}, ErrConflict},
		{"cross-book key", func(r *ApplyRequest) { r.RequestKey = requestKey(102, Query{Title: "Hidden"}) }, ErrInvalid},
		{"library move", func(r *ApplyRequest) { r.Patch.LibraryID = catalog.Optional[int64]{Set: true, Value: pages(10)} }, catalog.ErrInvalid},
		{"null library", func(r *ApplyRequest) { r.Patch.LibraryID = catalog.Optional[int64]{Set: true} }, catalog.ErrInvalid},
		{"invalid manual value", func(r *ApplyRequest) { r.Patch.PageCount = catalog.Optional[int64]{Set: true, Value: new(int64)} }, catalog.ErrInvalid},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := base
			test.change(&request)
			if _, err := f.service.Apply(ctx, administrator, 101, request); !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			assertUnchanged(t)
		})
	}
	for _, test := range []struct {
		field string
		value string
	}{
		{"title", `"Manual"`}, {"subtitle", "null"}, {"description", `"Manual"`},
		{"language", `"en"`}, {"publisher", `"Manual"`}, {"published_date", `"2025"`},
		{"page_count", "null"}, {"series", "null"}, {"authors", "[]"}, {"tags", "[]"}, {"identifiers", "[]"},
	} {
		t.Run("collision "+test.field, func(t *testing.T) {
			request := base
			request.Fields = map[string]Selection{test.field: selection}
			if err := json.Unmarshal([]byte(`{"`+test.field+`":`+test.value+`}`), &request.Patch); err != nil {
				t.Fatal(err)
			}
			if _, err := f.service.Apply(ctx, administrator, 101, request); !errors.Is(err, catalog.ErrInvalid) ||
				!strings.Contains(err.Error(), "overlap") {
				t.Fatalf("collision error = %v", err)
			}
			assertUnchanged(t)
		})
	}
	for _, statement := range []string{
		`UPDATE metadata_cache SET expires_at = 0`,
		`UPDATE metadata_cache SET schema_version = 999`,
		`UPDATE metadata_providers SET enabled = 0 WHERE provider = 'openlibrary'`,
	} {
		if _, err := f.db.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
		if _, err := f.service.Apply(ctx, administrator, 101, base); !errors.Is(err, ErrConflict) {
			t.Fatalf("stale selection error = %v", err)
		}
		assertUnchanged(t)
		if _, err := f.db.Writer.ExecContext(ctx, `
				UPDATE metadata_cache SET expires_at = 9999999999999, schema_version = 1;
				UPDATE metadata_providers SET enabled = 1 WHERE provider = 'openlibrary';
			`); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.db.Writer.ExecContext(ctx, `
			CREATE TRIGGER fail_mixed_provenance BEFORE UPDATE ON book_field_sources
			WHEN NEW.source = 'openlibrary' BEGIN SELECT RAISE(ABORT, 'fixture provenance failure'); END;
		`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Apply(ctx, administrator, 101, base); err == nil {
		t.Fatal("provenance failure did not reject mixed save")
	}
	assertUnchanged(t)
}

func TestBookISBNPrecedenceAndRateBuckets(t *testing.T) {
	book := catalog.Book{Title: "Fallback", Language: text("en"),
		Identifiers: []catalog.Identifier{{Scheme: "isbn10", Value: "123456789X"}, {Scheme: "isbn13", Value: "978-1234567897"}}}
	if q := bookQuery(book); q.ISBN != "9781234567897" || q.Title != "" || q.Language != "" {
		t.Fatalf("ISBN priority = %+v", q)
	}
	bucket := &tokenBucket{tokens: 1, interval: time.Second}
	if err := bucket.wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := bucket.wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("bucket cancellation = %v", err)
	}
	independent := &tokenBucket{tokens: 1, interval: time.Second}
	fresh, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer stop()
	if err := independent.wait(fresh); err != nil {
		t.Fatal(err)
	}
}

func TestLookupOverallTimeoutRetainsFastProvider(t *testing.T) {
	f := newServiceFixture(t)
	installStub(f.service, func(name string, ctx context.Context, _ Query) ([]Candidate, error) {
		if name == "openlibrary" {
			return []Candidate{stubCandidate(name)}, nil
		}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	start := time.Now()
	result, err := f.service.Lookup(context.Background(), administrator, 101)
	elapsed := time.Since(start)
	openlibrary, googlebooks := providerResult(result, "openlibrary"), providerResult(result, "googlebooks")
	if err != nil || elapsed > 8*time.Second || elapsed < 6*time.Second ||
		len(openlibrary.Candidates) != 1 || googlebooks.Error == nil || googlebooks.Error.Code != "timeout" {
		t.Fatalf("overall timeout = %v, %+v, %v", elapsed, result, err)
	}
	row, err := sqlc.New(f.db.Reader).MetadataGetCache(context.Background(),
		sqlc.MetadataGetCacheParams{Provider: "googlebooks", RequestKey: result.RequestKey})
	if err != nil || row.Status != 503 || row.ExpiresAt-row.FetchedAt != (10*time.Minute).Milliseconds() {
		t.Fatalf("timeout cache = %+v, %v", row, err)
	}
}

func TestProviderConfigCacheInvalidationRollsBackOnFailure(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	installStub(f.service, func(name string, _ context.Context, _ Query) ([]Candidate, error) {
		return []Candidate{stubCandidate(name)}, nil
	})
	if _, err := f.service.Lookup(ctx, administrator, 101); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Writer.ExecContext(ctx, `
		CREATE TRIGGER fail_cache_delete BEFORE DELETE ON metadata_cache
		BEGIN SELECT RAISE(ABORT, 'fixture cache delete failure'); END;
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.UpdateProvider(ctx, administrator, "googlebooks",
		providerPatch(t, `{"api_token":"must-not-persist"}`)); err == nil {
		t.Fatal("cache invalidation failure did not fail configuration")
	}
	settings, err := sqlc.New(f.db.Reader).MetadataGetProvider(ctx, "googlebooks")
	if err != nil || settings.ApiToken.Valid {
		t.Fatalf("failed configuration persisted credentials: %+v, %v", settings, err)
	}
}

func TestConfigurationWaitHonorsLookupCancellation(t *testing.T) {
	f := newServiceFixture(t)
	f.service.config.Lock()
	defer f.service.config.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := f.service.Lookup(ctx, administrator, 101); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("configuration lock cancellation = %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("configuration lock ignored lookup deadline")
	}
}

func TestLookupCustomQueryProviderFilterAndSelection(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	var calls atomic.Int64
	installStub(f.service, func(name string, _ context.Context, q Query) ([]Candidate, error) {
		calls.Add(1)
		if q.ISBN != "080442957X" || q.Title != "Custom Title" {
			t.Errorf("custom query %s = %+v", name, q)
		}
		return []Candidate{stubCandidate(name)}, nil
	})
	custom := &Query{ISBN: " 0-8044-2957-x ", Title: " Custom Title ", Providers: []string{"googlebooks", "googlebooks"}}
	result, err := f.service.LookupWith(ctx, administrator, 101, custom)
	if err != nil || len(result.Providers) != 1 || result.Providers[0].Provider != "googlebooks" || calls.Load() != 1 ||
		result.Query.ISBN != "080442957X" || !reflect.DeepEqual(result.Query.Providers, []string{"googlebooks"}) ||
		!validSelectionKey(101, result.RequestKey) {
		t.Fatalf("custom lookup = %+v, %v", result, err)
	}
	calls.Store(0)
	again, err := f.service.LookupWith(ctx, administrator, 101, &Query{ISBN: "080442957X", Title: "Custom Title"})
	// Without the filter both providers run, but googlebooks reuses the filtered lookup's cache row.
	if err != nil || again.RequestKey != result.RequestKey || len(again.Providers) != 4 || calls.Load() != 3 {
		t.Fatalf("provider filter changed cache identity: %+v calls=%d %v", again, calls.Load(), err)
	}
	book, err := f.service.Apply(ctx, administrator, 101, ApplyRequest{RequestKey: result.RequestKey,
		Fields: map[string]Selection{"title": {Provider: "googlebooks", Reference: "record123"}}})
	if err != nil || book.Title != "Chosen Title" {
		t.Fatalf("custom selection apply = %+v, %v", book, err)
	}
	for _, invalid := range []Query{{}, {Author: "Only"}, {ISBN: "12345"}, {Title: "x", Providers: []string{"evil"}},
		{Title: strings.Repeat("x", maxQueryText+1)}, {Title: "line\nbreak"}} {
		if _, err := f.service.LookupWith(ctx, administrator, 101, &invalid); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid query %+v = %v", invalid, err)
		}
	}
	if _, err := f.service.LookupWith(ctx, catalog.Viewer{UserID: 2}, 101, custom); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatalf("non-admin custom lookup = %v", err)
	}
}

func TestApplyGenresMoodsRatingsAndSeriesTotal(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	installStub(f.service, func(name string, _ context.Context, _ Query) ([]Candidate, error) {
		c := stubCandidate(name)
		total, age, count := int64(7), int64(13), int64(40)
		value := map[string]float64{"openlibrary": 4.25, "googlebooks": 3.5}[name]
		c.Series.Total, c.AgeRating, c.ContentRating = &total, &age, text("teen")
		c.Genres, c.Moods, c.Rating, c.RatingCount = []string{"Fantasy", "Adventure"}, []string{"Dark"}, &value, &count
		return []Candidate{c}, nil
	})
	lookup, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil {
		t.Fatal(err)
	}
	open := Selection{Provider: "openlibrary", Reference: "record123"}
	fields := map[string]Selection{}
	for _, field := range []string{"genres", "moods", "age_rating", "content_rating", "ratings", "series"} {
		fields[field] = open
	}
	book, err := f.service.Apply(ctx, administrator, 101, ApplyRequest{RequestKey: lookup.RequestKey, Fields: fields})
	if err != nil {
		t.Fatalf("apply new fields: %v", err)
	}
	if !reflect.DeepEqual(book.Genres, []string{"Fantasy", "Adventure"}) || !reflect.DeepEqual(book.Moods, []string{"Dark"}) ||
		book.AgeRating == nil || *book.AgeRating != 13 || book.ContentRating == nil || *book.ContentRating != "teen" ||
		book.Series == nil || book.Series.Total == nil || *book.Series.Total != 7 ||
		len(book.Ratings) != 1 || book.Ratings[0].Provider != "openlibrary" || *book.Ratings[0].Rating != 4.25 {
		t.Fatalf("new fields = %+v", book)
	}
	book, err = f.service.Apply(ctx, administrator, 101, ApplyRequest{RequestKey: lookup.RequestKey,
		Fields: map[string]Selection{"ratings": {Provider: "googlebooks", Reference: "record123"}}})
	if err != nil || len(book.Ratings) != 2 || book.Ratings[0].Provider != "googlebooks" || *book.Ratings[0].Rating != 3.5 ||
		book.Ratings[1].Provider != "openlibrary" || *book.Ratings[1].Count != 40 {
		t.Fatalf("ratings upsert = %+v, %v", book.Ratings, err)
	}
	sources := map[string]string{}
	for _, source := range book.FieldSources {
		sources[source.Field] = source.Source
	}
	if sources["genres"] != "openlibrary" || sources["ratings"] != "googlebooks" {
		t.Fatalf("new field sources = %+v", sources)
	}
}

func TestUpsertRatingKeepsOtherProviders(t *testing.T) {
	value := 4.0
	existing := []catalog.ProviderRating{{Provider: "openlibrary", Rating: &value}, {Provider: "hardcover", Rating: &value}}
	if got := upsertRating(existing, Candidate{Provider: "openlibrary"}); len(got) != 1 || got[0].Provider != "hardcover" {
		t.Fatalf("unrated candidate = %+v", got)
	}
	updated := 2.5
	got := upsertRating(existing, Candidate{Provider: "neodb", Rating: &updated})
	if len(got) != 3 || got[0].Provider != "hardcover" || got[1].Provider != "neodb" || got[2].Provider != "openlibrary" {
		t.Fatalf("upsert = %+v", got)
	}
}
