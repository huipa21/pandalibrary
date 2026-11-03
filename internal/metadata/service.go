package metadata

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

const cacheSchema = 1

// Service owns provider configuration, bounded lookups, and cached selections.
type Service struct {
	writer  *sql.DB
	reader  *sql.DB
	catalog *catalog.Service
	now     func() time.Time
	config  sync.RWMutex
	limits  map[string]*tokenBucket
	factory func(string, *string, string) (Provider, error)
}

// NewService uses the existing catalog service for visibility and all book writes.
func NewService(writer, reader *sql.DB, books *catalog.Service) (*Service, error) {
	if writer == nil || reader == nil || books == nil {
		return nil, errors.New("metadata requires databases and catalog")
	}
	limits := map[string]*tokenBucket{}
	for name := range providerOrigins {
		limits[name] = &tokenBucket{tokens: 1, interval: time.Second}
	}
	return &Service{writer: writer, reader: reader, catalog: books, now: time.Now,
		limits: limits, factory: newAdapter}, nil
}

type tokenBucket struct {
	mu       sync.Mutex
	tokens   float64
	last     time.Time
	interval time.Duration
}

// Configuration changes must not make lookups wait beyond their context deadline.
func waitForLock(ctx context.Context, tryLock func() bool) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if tryLock() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (b *tokenBucket) wait(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		b.mu.Lock()
		now := time.Now()
		if !b.last.IsZero() {
			b.tokens = min(1, b.tokens+float64(now.Sub(b.last))/float64(b.interval))
		}
		b.last = now
		if b.tokens >= 1 {
			b.tokens--
			b.mu.Unlock()
			return nil
		}
		delay := time.Duration((1 - b.tokens) * float64(b.interval))
		b.mu.Unlock()
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func admin(viewer catalog.Viewer) error {
	if viewer.UserID < 1 || !viewer.IsAdmin {
		return catalog.ErrForbidden
	}
	return nil
}

func settings(row sqlc.MetadataProvider) ProviderSettings {
	var base *string
	if row.BaseUrl.Valid {
		base = &row.BaseUrl.String
	}
	return ProviderSettings{Provider: row.Provider, Enabled: row.Enabled != 0,
		Priority: row.Priority, BaseURL: base, HasToken: row.ApiToken.Valid,
		UpdatedAt: time.UnixMilli(row.UpdatedAt).UTC()}
}

// ListProviders returns public settings only, never tokens or token hashes.
func (s *Service) ListProviders(ctx context.Context, viewer catalog.Viewer) ([]ProviderSettings, error) {
	if err := admin(viewer); err != nil {
		return nil, err
	}
	rows, err := sqlc.New(s.reader).MetadataListProviders(ctx)
	if err != nil {
		return nil, fmt.Errorf("list metadata providers: %w", err)
	}
	result := make([]ProviderSettings, 0, len(rows))
	for _, row := range rows {
		result = append(result, settings(row))
	}
	return result, nil
}

// UpdateProvider applies write-only credential changes and invalidates its cache atomically.
func (s *Service) UpdateProvider(ctx context.Context, viewer catalog.Viewer, name string, patch ProviderPatch) (ProviderSettings, error) {
	if err := admin(viewer); err != nil {
		return ProviderSettings{}, err
	}
	if _, ok := providerOrigins[name]; !ok {
		return ProviderSettings{}, ErrNotFound
	}
	if !patch.Enabled.Set && !patch.Priority.Set && !patch.BaseURL.Set && !patch.APIToken.Set {
		return ProviderSettings{}, ErrInvalid
	}
	if err := waitForLock(ctx, s.config.TryLock); err != nil {
		return ProviderSettings{}, err
	}
	defer s.config.Unlock()
	var result ProviderSettings
	err := db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		q := sqlc.New(tx)
		row, err := q.MetadataGetProvider(ctx, name)
		if err != nil {
			return fmt.Errorf("load provider settings: %w", err)
		}
		if patch.Enabled.Set {
			if patch.Enabled.Value == nil {
				return ErrInvalid
			}
			row.Enabled = 0
			if *patch.Enabled.Value {
				row.Enabled = 1
			}
		}
		if patch.Priority.Set {
			if patch.Priority.Value == nil || *patch.Priority.Value < 0 || *patch.Priority.Value > 10000 {
				return ErrInvalid
			}
			row.Priority = *patch.Priority.Value
		}
		if patch.APIToken.Set {
			row.ApiToken = sql.NullString{}
			if patch.APIToken.Value != nil {
				token := strings.TrimSpace(*patch.APIToken.Value)
				if token == "" || len(token) > 8192 || strings.ContainsAny(token, "\r\n\t\x00") || !utf8.ValidString(token) || name == "openlibrary" {
					return ErrInvalid
				}
				row.ApiToken = sql.NullString{String: token, Valid: true}
			}
		}
		if patch.BaseURL.Set {
			row.BaseUrl = sql.NullString{}
			if patch.BaseURL.Value != nil {
				row.BaseUrl = sql.NullString{String: strings.TrimSpace(*patch.BaseURL.Value), Valid: true}
			}
		}
		if row.Enabled != 0 && (name == "neodb" || name == "hardcover") && !row.ApiToken.Valid {
			return ErrInvalid
		}
		var base *string
		if row.BaseUrl.Valid {
			base = &row.BaseUrl.String
		}
		u, err := parseBase(name, base)
		if err != nil {
			return ErrInvalid
		}
		if base != nil {
			row.BaseUrl.String = u.String()
		}
		row.UpdatedAt = s.now().UnixMilli()
		if _, err := q.MetadataUpdateProvider(ctx, sqlc.MetadataUpdateProviderParams{
			Provider: name, Enabled: row.Enabled, Priority: row.Priority, BaseUrl: row.BaseUrl,
			ApiToken: row.ApiToken, UpdatedAt: row.UpdatedAt,
		}); err != nil {
			return fmt.Errorf("update provider settings: %w", err)
		}
		if err := q.MetadataClearProviderCache(ctx, name); err != nil {
			return fmt.Errorf("invalidate provider cache: %w", err)
		}
		result = settings(row)
		return nil
	})
	return result, err
}

func bookQuery(book catalog.Book) Query {
	for _, scheme := range []string{"isbn13", "isbn10"} {
		for _, id := range book.Identifiers {
			if id.Scheme == scheme && strings.TrimSpace(id.Value) != "" {
				return Query{ISBN: strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(id.Value))}
			}
		}
	}
	q := Query{Title: book.Title}
	for _, person := range book.Authors {
		if person.Role == "author" {
			q.Author = person.Name
			break
		}
	}
	if book.Language != nil {
		q.Language = *book.Language
	}
	return q
}

func requestKey(bookID int64, query Query) string {
	data, _ := json.Marshal(query)
	sum := sha256.Sum256(data)
	return fmt.Sprintf("book:%d:%s", bookID, hex.EncodeToString(sum[:]))
}

// Lookup queries enabled providers concurrently, ordered by configured priority.
func (s *Service) Lookup(ctx context.Context, viewer catalog.Viewer, bookID int64) (LookupResponse, error) {
	if err := admin(viewer); err != nil {
		return LookupResponse{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	book, err := s.catalog.GetBook(ctx, viewer, bookID)
	if err != nil {
		return LookupResponse{}, err
	}
	if err := waitForLock(ctx, s.config.TryRLock); err != nil {
		return LookupResponse{}, err
	}
	defer s.config.RUnlock()
	rows, err := sqlc.New(s.reader).MetadataListProviders(ctx)
	if err != nil {
		return LookupResponse{}, fmt.Errorf("load lookup providers: %w", err)
	}
	query := bookQuery(book)
	response := LookupResponse{RequestKey: requestKey(bookID, query), Query: query, Providers: []ProviderResult{}}
	enabled := []sqlc.MetadataProvider{}
	for _, row := range rows {
		if row.Enabled != 0 {
			enabled = append(enabled, row)
		}
	}
	response.Providers = make([]ProviderResult, len(enabled))
	var group sync.WaitGroup
	for i, row := range enabled {
		group.Go(func() {
			response.Providers[i] = s.lookupProvider(ctx, row, response.RequestKey, query)
		})
	}
	group.Wait()
	return response, nil
}

func (s *Service) readCache(ctx context.Context, name, key string) (ProviderResult, bool, error) {
	row, err := sqlc.New(s.reader).MetadataGetCache(ctx, sqlc.MetadataGetCacheParams{Provider: name, RequestKey: key})
	if errors.Is(err, sql.ErrNoRows) {
		return ProviderResult{}, false, nil
	}
	if err != nil {
		return ProviderResult{}, false, err
	}
	if row.SchemaVersion != cacheSchema || row.ExpiresAt <= s.now().UnixMilli() {
		return ProviderResult{}, false, nil
	}
	var result ProviderResult
	if len(row.Response) > 2*maxResponseBytes || json.Unmarshal([]byte(row.Response), &result) != nil ||
		result.Provider != name || result.Candidates == nil ||
		(row.Status == 200 && result.Error != nil) || (row.Status == 404 && (result.Error != nil || len(result.Candidates) != 0)) ||
		(row.Status != 200 && row.Status != 404 && result.Error == nil) {
		return ProviderResult{}, false, failure("invalid_cache")
	}
	for _, candidate := range result.Candidates {
		if candidate.Provider != name || candidate.Reference == "" || candidate.Title == "" {
			return ProviderResult{}, false, failure("invalid_cache")
		}
	}
	return result, true, nil
}

func failedResult(name, code string) ProviderResult {
	return ProviderResult{Provider: name, Candidates: []Candidate{}, Error: lookupFailure(failure(code))}
}

func (s *Service) lookupProvider(ctx context.Context, row sqlc.MetadataProvider, key string, query Query) ProviderResult {
	cached, hit, err := s.readCache(ctx, row.Provider, key)
	if err != nil {
		return failedResult(row.Provider, "cache_read_failed")
	}
	if hit {
		return cached
	}
	base := settings(row).BaseURL
	provider, err := s.factory(row.Provider, base, row.ApiToken.String)
	var candidates []Candidate
	if err == nil {
		// Reserve time for persisting a timeout result within the overall budget.
		providerCtx, cancel := context.WithTimeout(ctx, 7*time.Second)
		err = s.limits[row.Provider].wait(providerCtx)
		if err == nil {
			candidates, err = provider.Search(providerCtx, query)
		}
		cancel()
	}
	result := ProviderResult{Provider: row.Provider, Candidates: []Candidate{}}
	status, ttl := int64(200), 30*24*time.Hour
	switch {
	case errors.Is(err, ErrNotFound), err == nil && len(candidates) == 0:
		status, ttl = 404, 7*24*time.Hour
	case err != nil:
		status, ttl = 503, 10*time.Minute
		result.Error = lookupFailure(err)
	default:
		result.Candidates = candidates
	}
	data, err := json.Marshal(result)
	if err != nil {
		return failedResult(row.Provider, "cache_encode_failed")
	}
	now := s.now()
	if err := sqlc.New(s.writer).MetadataUpsertCache(ctx, sqlc.MetadataUpsertCacheParams{
		Provider: row.Provider, RequestKey: key, Status: status, SchemaVersion: cacheSchema,
		Response: string(data), FetchedAt: now.UnixMilli(), ExpiresAt: now.Add(ttl).UnixMilli(),
	}); err != nil {
		result.Error = lookupFailure(failure("cache_write_failed"))
	}
	return result
}

func validSelectionKey(bookID int64, key string) bool {
	prefix := fmt.Sprintf("book:%d:", bookID)
	if !strings.HasPrefix(key, prefix) || len(key) != len(prefix)+64 {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(key, prefix))
	return err == nil
}

func (s *Service) selected(ctx context.Context, key string, selection Selection) (Candidate, sqlc.MetadataProvider, error) {
	if _, ok := providerOrigins[selection.Provider]; !ok || selection.Reference == "" {
		return Candidate{}, sqlc.MetadataProvider{}, ErrInvalid
	}
	row, err := sqlc.New(s.reader).MetadataGetProvider(ctx, selection.Provider)
	if err != nil {
		return Candidate{}, row, fmt.Errorf("load selected provider: %w", err)
	}
	if row.Enabled == 0 {
		return Candidate{}, row, ErrConflict
	}
	result, hit, err := s.readCache(ctx, selection.Provider, key)
	if err != nil {
		return Candidate{}, row, fmt.Errorf("read selected candidate: %w", err)
	}
	if !hit || result.Error != nil {
		return Candidate{}, row, ErrConflict
	}
	for _, candidate := range result.Candidates {
		if candidate.Reference == selection.Reference {
			return candidate, row, nil
		}
	}
	return Candidate{}, row, ErrConflict
}
