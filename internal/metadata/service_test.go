package metadata

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
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
	if err != nil || len(result.Providers) != 2 || time.Since(start) > 2*time.Second {
		t.Fatalf("parallel lookup = %+v, %v", result, err)
	}
	if result.Providers[0].Provider != "openlibrary" || len(result.Providers[0].Candidates) != 1 ||
		result.Providers[1].Error == nil || result.Providers[1].Error.Code != "rate_limited" {
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
	if _, err := f.service.Lookup(ctx, administrator, 101); err != nil || calls.Load() != 2 {
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
	if _, err := f.service.Lookup(ctx, administrator, 101); err != nil || calls.Load() != 3 {
		t.Fatalf("negative expiry calls=%d err=%v", calls.Load(), err)
	}
	if _, err := f.db.Writer.ExecContext(ctx, `UPDATE metadata_cache SET schema_version = 999 WHERE provider = 'openlibrary'`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Lookup(ctx, administrator, 101); err != nil || calls.Load() != 4 {
		t.Fatalf("schema invalidation calls=%d err=%v", calls.Load(), err)
	}
	if _, err := f.db.Writer.ExecContext(ctx, `UPDATE metadata_cache SET response = '{}' WHERE provider = 'openlibrary'`); err != nil {
		t.Fatal(err)
	}
	corrupt, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil || corrupt.Providers[0].Error == nil || corrupt.Providers[0].Error.Code != "cache_read_failed" {
		t.Fatalf("corrupt cache not explicit: %+v %v", corrupt, err)
	}
	if _, err := f.db.Writer.ExecContext(ctx, `
		DELETE FROM metadata_cache;
		CREATE TRIGGER fail_metadata_cache BEFORE INSERT ON metadata_cache BEGIN SELECT RAISE(ABORT, 'fixture cache failure'); END;
	`); err != nil {
		t.Fatal(err)
	}
	failed, err := f.service.Lookup(ctx, administrator, 101)
	if err != nil || failed.Providers[0].Error == nil || failed.Providers[0].Error.Code != "cache_write_failed" {
		t.Fatalf("cache write failure = %+v %v", failed, err)
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
	if err != nil || marshalErr != nil || strings.Contains(string(data), "write-only-fixture-token") ||
		strings.Contains(string(data), "api_token") || list[0].Provider != "neodb" {
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
	if err != nil || elapsed > 8*time.Second || elapsed < 6*time.Second ||
		len(result.Providers[0].Candidates) != 1 || result.Providers[1].Error == nil || result.Providers[1].Error.Code != "timeout" {
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
