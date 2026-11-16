package dictionary

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"

	"pandalibrary/internal/catalog"
)

const (
	requestTimeout   = 10 * time.Second
	maxResponseSize  = 4 << 20
	statusCacheTTL   = 5 * time.Minute
	statusFailureTTL = 30 * time.Second
	maxBaseURLBytes  = 2048
	maxAPIKeyBytes   = 8192
	maxDetailRunes   = 300
	maxNameRunes     = 200
	maxPriority      = 10000
	priorityStep     = 10
	testWord         = "test"
)

// Service queries the administrator-configured online dictionary providers, caches their
// responses and manages the provider list.
type Service struct {
	writer *sql.DB
	reader *sql.DB
	cache  *Cache
	logger *slog.Logger
	client *http.Client
	now    func() time.Time
	// presetBases replaces Preset.RequestBase per kind; tests point presets at local servers.
	presetBases map[string]string

	mu         sync.Mutex
	loaded     bool
	providers  []storedProvider
	generation uint64
	statuses   map[int64]remoteStatus
}

type storedProvider struct {
	id        int64
	kind      string
	name      string
	baseURL   sql.NullString
	apiKey    sql.NullString
	enabled   bool
	priority  int64
	updatedAt int64
}

// remoteStatus remembers the last successful and the last failed status of a custom provider.
type remoteStatus struct {
	status   *Status
	at       time.Time
	err      error
	failedAt time.Time
}

// NewService returns a dictionary service backed by the dictionary_providers table.
// cache may be nil, which disables response caching.
func NewService(writer, reader *sql.DB, cache *Cache, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Service{
		writer: writer, reader: reader, cache: cache, logger: logger,
		client: &http.Client{}, now: time.Now, statuses: map[int64]remoteStatus{},
	}
}

func admin(viewer catalog.Viewer) error {
	if viewer.UserID < 1 || !viewer.IsAdmin {
		return catalog.ErrForbidden
	}
	return nil
}

func (p storedProvider) preset() (Preset, bool) {
	if p.kind == KindCustom {
		return Preset{}, false
	}
	return PresetByKind(p.kind)
}

// usable reports whether lookups may use the provider.
func (p storedProvider) usable() bool {
	if !p.enabled {
		return false
	}
	if p.kind == KindCustom {
		return p.baseURL.Valid
	}
	_, ok := PresetByKind(p.kind)
	return ok && p.apiKey.Valid
}

const providerColumns = `id, kind, name, base_url, api_key, enabled, priority, updated_at`

type scanner interface{ Scan(dest ...any) error }

func scanProvider(row scanner) (storedProvider, error) {
	var p storedProvider
	err := row.Scan(&p.id, &p.kind, &p.name, &p.baseURL, &p.apiKey, &p.enabled, &p.priority, &p.updatedAt)
	return p, err
}

func loadProviders(ctx context.Context, database *sql.DB) ([]storedProvider, error) {
	rows, err := database.QueryContext(ctx, `SELECT `+providerColumns+` FROM dictionary_providers ORDER BY priority, id`)
	if err != nil {
		return nil, fmt.Errorf("load dictionary providers: %w", err)
	}
	defer rows.Close()
	providers := []storedProvider{}
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, fmt.Errorf("load dictionary providers: %w", err)
		}
		providers = append(providers, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("load dictionary providers: %w", err)
	}
	return providers, nil
}

func loadProvider(ctx context.Context, database *sql.DB, id int64) (storedProvider, error) {
	p, err := scanProvider(database.QueryRowContext(ctx, `SELECT `+providerColumns+` FROM dictionary_providers WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return storedProvider{}, ErrNotFound
	}
	if err != nil {
		return storedProvider{}, fmt.Errorf("load dictionary provider: %w", err)
	}
	return p, nil
}

// current returns the cached providers and their generation, loading them on first use.
func (s *Service) current(ctx context.Context) ([]storedProvider, uint64, error) {
	s.mu.Lock()
	if s.loaded {
		defer s.mu.Unlock()
		return s.providers, s.generation, nil
	}
	generation := s.generation
	s.mu.Unlock()
	providers, err := loadProviders(ctx, s.reader)
	if err != nil {
		return nil, 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation == generation {
		s.providers, s.loaded = providers, true
	}
	return providers, generation, nil
}

// changedLocked invalidates cached providers after a write and reloads them from the writer;
// the remote status of every listed provider is forgotten. The caller holds s.mu.
func (s *Service) changedLocked(ctx context.Context, forget ...int64) error {
	s.generation++
	s.loaded, s.providers = false, nil
	for _, id := range forget {
		delete(s.statuses, id)
	}
	providers, err := loadProviders(ctx, s.writer)
	if err != nil {
		return err
	}
	s.providers, s.loaded = providers, true
	return nil
}

// publicLocked converts a stored provider to its administrator view. The caller holds s.mu.
func (s *Service) publicLocked(p storedProvider) Provider {
	public := Provider{
		ID: p.id, Kind: p.kind, Name: p.name, HasAPIKey: p.apiKey.Valid, Enabled: p.enabled,
		Priority: p.priority, Directions: []Direction{}, UpdatedAt: time.UnixMilli(p.updatedAt).UTC(),
	}
	if p.baseURL.Valid {
		base := p.baseURL.String
		public.BaseURL = &base
	}
	if preset, ok := p.preset(); ok {
		public.Preset, public.SignupURL = true, preset.SignupURL
		public.Directions = cloneDirections(preset.Directions)
	} else if cached, ok := s.statuses[p.id]; ok && cached.status != nil {
		public.Directions = cloneDirections(cached.status.Directions)
	}
	return public
}

func (s *Service) findLocked(id int64) (Provider, error) {
	for _, p := range s.providers {
		if p.id == id {
			return s.publicLocked(p), nil
		}
	}
	return Provider{}, ErrNotFound
}

// ListProviders returns every provider and the number of cached responses; API keys are never returned.
func (s *Service) ListProviders(ctx context.Context, viewer catalog.Viewer) (Providers, error) {
	if err := admin(viewer); err != nil {
		return Providers{}, err
	}
	providers, _, err := s.current(ctx)
	if err != nil {
		return Providers{}, err
	}
	result := Providers{Providers: make([]Provider, 0, len(providers))}
	s.mu.Lock()
	for _, p := range providers {
		result.Providers = append(result.Providers, s.publicLocked(p))
	}
	s.mu.Unlock()
	count, err := s.cache.Count(ctx)
	if err != nil {
		s.logger.WarnContext(ctx, "count dictionary cache entries", "error", err)
		count = 0
	}
	result.CacheEntries = count
	return result, nil
}

// CreateProvider adds an enabled custom provider.
func (s *Service) CreateProvider(ctx context.Context, viewer catalog.Viewer, input ProviderInput) (Provider, error) {
	if err := admin(viewer); err != nil {
		return Provider{}, err
	}
	name, err := validateName(input.Name)
	if err != nil {
		return Provider{}, err
	}
	base, err := normalizeBaseURL(strings.TrimSpace(input.BaseURL))
	if err != nil {
		return Provider{}, err
	}
	var key sql.NullString
	if input.APIKey != nil && strings.TrimSpace(*input.APIKey) != "" {
		if key, err = validateKey(*input.APIKey); err != nil {
			return Provider{}, err
		}
	}
	if input.Priority != nil {
		if err := validatePriority(*input.Priority); err != nil {
			return Provider{}, err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	var priority int64
	if input.Priority != nil {
		priority = *input.Priority
	} else {
		var highest int64
		if err := s.writer.QueryRowContext(ctx, `SELECT COALESCE(MAX(priority), 0) FROM dictionary_providers`).Scan(&highest); err != nil {
			return Provider{}, fmt.Errorf("create dictionary provider: %w", err)
		}
		priority = min(max(highest+priorityStep, 0), maxPriority)
	}
	now := s.now().UnixMilli()
	result, err := s.writer.ExecContext(ctx,
		`INSERT INTO dictionary_providers (kind, name, base_url, api_key, enabled, priority, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 1, ?, ?, ?)`, KindCustom, name, base, key, priority, now, now)
	if err != nil {
		return Provider{}, fmt.Errorf("create dictionary provider: %w", err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return Provider{}, fmt.Errorf("create dictionary provider: %w", err)
	}
	if err := s.changedLocked(ctx, id); err != nil {
		return Provider{}, err
	}
	return s.findLocked(id)
}

// UpdateProvider applies a partial provider change.
func (s *Service) UpdateProvider(ctx context.Context, viewer catalog.Viewer, id int64, patch ProviderPatch) (Provider, error) {
	if err := admin(viewer); err != nil {
		return Provider{}, err
	}
	if !patch.Name.Set && !patch.BaseURL.Set && !patch.APIKey.Set && !patch.Enabled.Set && !patch.Priority.Set {
		return Provider{}, fmt.Errorf("%w: no provider changes", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := loadProvider(ctx, s.writer, id)
	if err != nil {
		return Provider{}, err
	}
	_, isPreset := current.preset()
	next := current
	if patch.Name.Set {
		if isPreset {
			return Provider{}, fmt.Errorf("%w: preset names cannot be changed", ErrInvalid)
		}
		if patch.Name.Value == nil {
			return Provider{}, fmt.Errorf("%w: the name is required", ErrInvalid)
		}
		if next.name, err = validateName(*patch.Name.Value); err != nil {
			return Provider{}, err
		}
	}
	if patch.BaseURL.Set {
		if isPreset {
			return Provider{}, fmt.Errorf("%w: preset addresses cannot be changed", ErrInvalid)
		}
		if patch.BaseURL.Value == nil {
			return Provider{}, fmt.Errorf("%w: custom providers need a base URL", ErrInvalid)
		}
		base, err := normalizeBaseURL(strings.TrimSpace(*patch.BaseURL.Value))
		if err != nil {
			return Provider{}, err
		}
		next.baseURL = sql.NullString{String: base, Valid: true}
	}
	if patch.APIKey.Set {
		next.apiKey = sql.NullString{}
		if patch.APIKey.Value != nil {
			if next.apiKey, err = validateKey(*patch.APIKey.Value); err != nil {
				return Provider{}, err
			}
		}
	}
	switch {
	case patch.Enabled.Set:
		if patch.Enabled.Value == nil {
			return Provider{}, fmt.Errorf("%w: enabled must be true or false", ErrInvalid)
		}
		next.enabled = *patch.Enabled.Value
	case isPreset && patch.APIKey.Set:
		next.enabled = next.apiKey.Valid
	}
	if isPreset && next.enabled && !next.apiKey.Valid {
		return Provider{}, fmt.Errorf("%w: an API key is required to enable this provider", ErrInvalid)
	}
	if patch.Priority.Set {
		if patch.Priority.Value == nil {
			return Provider{}, fmt.Errorf("%w: the priority is required", ErrInvalid)
		}
		if err := validatePriority(*patch.Priority.Value); err != nil {
			return Provider{}, err
		}
		next.priority = *patch.Priority.Value
	}
	next.updatedAt = s.now().UnixMilli()
	if _, err := s.writer.ExecContext(ctx,
		`UPDATE dictionary_providers SET name = ?, base_url = ?, api_key = ?, enabled = ?, priority = ?, updated_at = ? WHERE id = ?`,
		next.name, next.baseURL, next.apiKey, next.enabled, next.priority, next.updatedAt, id,
	); err != nil {
		return Provider{}, fmt.Errorf("update dictionary provider: %w", err)
	}
	baseChanged := next.baseURL != current.baseURL
	var forget []int64
	if baseChanged || next.apiKey != current.apiKey {
		forget = append(forget, id)
	}
	if baseChanged {
		if err := s.cache.DeleteProvider(ctx, id); err != nil {
			s.logger.ErrorContext(ctx, "clear cached dictionary responses", "provider", id, "error", err)
		}
	}
	if err := s.changedLocked(ctx, forget...); err != nil {
		return Provider{}, err
	}
	return s.findLocked(id)
}

// DeleteProvider removes a custom provider and its cached responses; presets cannot be deleted.
func (s *Service) DeleteProvider(ctx context.Context, viewer catalog.Viewer, id int64) error {
	if err := admin(viewer); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := loadProvider(ctx, s.writer, id)
	if err != nil {
		return err
	}
	if _, isPreset := current.preset(); isPreset {
		return fmt.Errorf("%w: presets cannot be deleted; remove the API key to disable them", ErrInvalid)
	}
	if _, err := s.writer.ExecContext(ctx, `DELETE FROM dictionary_providers WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete dictionary provider: %w", err)
	}
	if err := s.cache.DeleteProvider(ctx, id); err != nil {
		s.logger.ErrorContext(ctx, "clear cached dictionary responses", "provider", id, "error", err)
	}
	return s.changedLocked(ctx, id)
}

// TestProvider calls a provider live, bypassing caches; disabled providers can be tested.
func (s *Service) TestProvider(ctx context.Context, viewer catalog.Viewer, id int64) (Status, error) {
	if err := admin(viewer); err != nil {
		return Status{}, err
	}
	providers, generation, err := s.current(ctx)
	if err != nil {
		return Status{}, err
	}
	index := slices.IndexFunc(providers, func(p storedProvider) bool { return p.id == id })
	if index < 0 {
		return Status{}, ErrNotFound
	}
	p := providers[index]
	if p.kind == KindCustom {
		if !p.baseURL.Valid {
			return Status{}, ErrNotConfigured
		}
		return s.customStatus(ctx, p, generation, true)
	}
	preset, ok := p.preset()
	if !ok || !p.apiKey.Valid {
		return Status{}, ErrNotConfigured
	}
	body, err := s.mwGet(ctx, p, preset, testWord)
	if err != nil {
		return Status{}, err
	}
	if _, err := parseMW(preset, body, testWord); err != nil {
		return Status{}, err
	}
	return presetStatus(preset), nil
}

// ClearCache removes every cached response and returns how many were removed.
func (s *Service) ClearCache(ctx context.Context, viewer catalog.Viewer) (int64, error) {
	if err := admin(viewer); err != nil {
		return 0, err
	}
	return s.cache.Clear(ctx)
}

func validateName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxNameRunes || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", fmt.Errorf("%w: the name must contain 1 to %d characters without control characters", ErrInvalid, maxNameRunes)
	}
	return name, nil
}

func validateKey(raw string) (sql.NullString, error) {
	key := strings.TrimSpace(raw)
	if key == "" || len(key) > maxAPIKeyBytes || !utf8.ValidString(key) || strings.IndexFunc(key, unicode.IsSpace) >= 0 || strings.IndexFunc(key, unicode.IsControl) >= 0 {
		return sql.NullString{}, fmt.Errorf("%w: the API key is invalid", ErrInvalid)
	}
	return sql.NullString{String: key, Valid: true}, nil
}

func validatePriority(priority int64) error {
	if priority < 0 || priority > maxPriority {
		return fmt.Errorf("%w: the priority must be between 0 and %d", ErrInvalid, maxPriority)
	}
	return nil
}

func normalizeBaseURL(raw string) (string, error) {
	invalid := fmt.Errorf("%w: the base URL must be an absolute http or https URL without credentials, query or fragment", ErrInvalid)
	if len(raw) > maxBaseURLBytes || strings.ContainsAny(raw, "?#\\") ||
		strings.IndexFunc(raw, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return "", invalid
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Opaque != "" || u.Hostname() == "" ||
		u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.HasSuffix(u.Host, ":") {
		return "", invalid
	}
	if u.Port() != "" {
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return "", invalid
		}
	}
	normalized := strings.TrimRight(u.String(), "/")
	if len(normalized) > maxBaseURLBytes {
		return "", invalid
	}
	return normalized, nil
}

func presetStatus(preset Preset) Status {
	return Status{
		Directions: cloneDirections(preset.Directions),
		Sources:    []SourceInfo{{ID: preset.Kind, Name: preset.Name, URL: preset.SignupURL}},
	}
}

// Status reports the union of directions served by enabled providers. Custom providers that
// cannot be reached are skipped; with no providers the status is empty.
func (s *Service) Status(ctx context.Context) (Status, error) {
	providers, generation, err := s.current(ctx)
	if err != nil {
		return Status{}, err
	}
	statuses := make([]*Status, len(providers))
	var wg sync.WaitGroup
	for i, p := range providers {
		if !p.usable() {
			continue
		}
		if preset, ok := p.preset(); ok {
			status := presetStatus(preset)
			statuses[i] = &status
			continue
		}
		wg.Go(func() {
			status, err := s.customStatus(ctx, p, generation, false)
			if err != nil {
				if ctx.Err() == nil {
					s.logger.WarnContext(ctx, "dictionary provider status is unavailable", "provider", p.id, "error", err)
				}
				return
			}
			statuses[i] = &status
		})
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return Status{}, err
	}
	return mergeStatuses(statuses), nil
}

func mergeStatuses(statuses []*Status) Status {
	type direction struct{ from, to Lang }
	sources := map[direction][]string{}
	merged := Status{Directions: []Direction{}, Sources: []SourceInfo{}}
	seen := map[string]bool{}
	for _, status := range statuses {
		if status == nil {
			continue
		}
		for _, d := range status.Directions {
			key := direction{d.From, d.To}
			list, ok := sources[key]
			if !ok {
				list = []string{}
			}
			for _, source := range d.Sources {
				if !slices.Contains(list, source) {
					list = append(list, source)
				}
			}
			sources[key] = list
		}
		for _, info := range status.Sources {
			if !seen[info.ID] {
				seen[info.ID] = true
				merged.Sources = append(merged.Sources, info)
			}
		}
	}
	for _, from := range Languages {
		for _, to := range Languages {
			if list, ok := sources[direction{from, to}]; ok {
				merged.Directions = append(merged.Directions, Direction{From: from, To: to, Sources: list})
			}
		}
	}
	return merged
}

// customStatus returns the remote status of a custom provider, using the in-memory cache unless refresh is set.
func (s *Service) customStatus(ctx context.Context, p storedProvider, generation uint64, refresh bool) (Status, error) {
	if !refresh {
		s.mu.Lock()
		cached, ok := s.statuses[p.id]
		s.mu.Unlock()
		now := s.now()
		switch {
		case ok && cached.err != nil && now.Sub(cached.failedAt) < statusFailureTTL:
			return Status{}, cached.err
		case ok && cached.err == nil && cached.status != nil && now.Sub(cached.at) < statusCacheTTL:
			return cloneStatus(*cached.status), nil
		}
	}
	status, err := s.fetchStatus(ctx, p)
	if err != nil && ctx.Err() != nil {
		return Status{}, ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation == generation || s.statusStillCurrentLocked(p) {
		cached := s.statuses[p.id]
		if err != nil {
			cached.err, cached.failedAt = err, s.now()
		} else {
			stored := cloneStatus(status)
			cached.status, cached.at, cached.err = &stored, s.now(), nil
		}
		s.statuses[p.id] = cached
	}
	return status, err
}

// statusStillCurrentLocked reports whether p still has the address and key it was fetched with.
func (s *Service) statusStillCurrentLocked(p storedProvider) bool {
	if !s.loaded {
		return false
	}
	for _, current := range s.providers {
		if current.id == p.id {
			return current.baseURL == p.baseURL && current.apiKey == p.apiKey
		}
	}
	return false
}

func (s *Service) fetchStatus(ctx context.Context, p storedProvider) (Status, error) {
	body, err := s.customGet(ctx, p, "status", nil)
	if err != nil {
		return Status{}, err
	}
	var remote Status
	if err := json.Unmarshal(body, &remote); err != nil {
		return Status{}, fmt.Errorf("%w: response is not valid JSON", ErrUnavailable)
	}
	status := Status{Directions: []Direction{}, Sources: []SourceInfo{}}
	for _, direction := range remote.Directions {
		from, okFrom := ParseLang(string(direction.From))
		to, okTo := ParseLang(string(direction.To))
		if !okFrom || !okTo {
			continue
		}
		sources := direction.Sources
		if sources == nil {
			sources = []string{}
		}
		status.Directions = append(status.Directions, Direction{From: from, To: to, Sources: sources})
	}
	if remote.Sources != nil {
		status.Sources = remote.Sources
	}
	return status, nil
}

func cloneDirections(directions []Direction) []Direction {
	clone := make([]Direction, len(directions))
	for i, direction := range directions {
		direction.Sources = append([]string{}, direction.Sources...)
		clone[i] = direction
	}
	return clone
}

func cloneStatus(status Status) Status {
	return Status{Directions: cloneDirections(status.Directions), Sources: append([]SourceInfo{}, status.Sources...)}
}

func serves(directions []Direction, from, to Lang) bool {
	return slices.ContainsFunc(directions, func(d Direction) bool { return d.From == from && d.To == to })
}

type lookupOutcome struct {
	serves  bool
	entries []Entry
	err     error
}

// Lookup validates the query and asks every enabled provider serving its direction, in priority order.
func (s *Service) Lookup(ctx context.Context, query Query) (Result, error) {
	query.Text = strings.TrimSpace(query.Text)
	if query.Text == "" || utf8.RuneCountInString(query.Text) > MaxQueryRunes {
		return Result{}, fmt.Errorf("%w: the query must contain 1 to %d characters", ErrInvalid, MaxQueryRunes)
	}
	if _, ok := ParseLang(string(query.From)); !ok {
		return Result{}, fmt.Errorf("%w: unsupported source language", ErrInvalid)
	}
	if _, ok := ParseLang(string(query.To)); !ok {
		return Result{}, fmt.Errorf("%w: unsupported target language", ErrInvalid)
	}
	switch {
	case query.Limit < 0:
		return Result{}, fmt.Errorf("%w: the limit must not be negative", ErrInvalid)
	case query.Limit == 0:
		query.Limit = DefaultLimit
	case query.Limit > MaxLimit:
		query.Limit = MaxLimit
	}
	providers, generation, err := s.current(ctx)
	if err != nil {
		return Result{}, err
	}
	normalized := strings.ToLower(norm.NFC.String(query.Text))
	outcomes := make([]lookupOutcome, len(providers))
	var wg sync.WaitGroup
	for i, p := range providers {
		if p.usable() {
			wg.Go(func() { outcomes[i] = s.lookupProvider(ctx, p, generation, query, normalized) })
		}
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return Result{}, err
	}

	result := Result{Query: query.Text, Term: query.Text, From: query.From, To: query.To, Entries: []Entry{}}
	attempted, failed := 0, 0
	var invalidErr error
	for i, outcome := range outcomes {
		if !outcome.serves {
			continue
		}
		attempted++
		if outcome.err != nil {
			failed++
			if invalidErr == nil && errors.Is(outcome.err, ErrInvalid) {
				invalidErr = outcome.err
			}
			s.logger.WarnContext(ctx, "dictionary provider lookup failed",
				"provider", providers[i].id, "kind", providers[i].kind, "error", outcome.err)
			continue
		}
		result.Entries = append(result.Entries, outcome.entries...)
	}
	switch {
	case attempted == 0:
		return Result{}, ErrNotConfigured
	case failed == attempted && invalidErr != nil:
		return Result{}, invalidErr
	case failed == attempted:
		return Result{}, fmt.Errorf("%w: every dictionary provider failed", ErrUnavailable)
	}
	if len(result.Entries) > query.Limit {
		result.Entries = result.Entries[:query.Limit]
	}
	for i := range result.Entries {
		entry := &result.Entries[i]
		if entry.From == "" {
			entry.From = query.From
		}
		if entry.To == "" {
			entry.To = query.To
		}
		if entry.Definitions == nil {
			entry.Definitions = []string{}
		}
	}
	if len(result.Entries) > 0 && result.Entries[0].Headword != "" {
		result.Term = result.Entries[0].Headword
	}
	return result, nil
}

func (s *Service) lookupProvider(ctx context.Context, p storedProvider, generation uint64, query Query, normalized string) lookupOutcome {
	if preset, ok := p.preset(); ok {
		if !serves(preset.Directions, query.From, query.To) {
			return lookupOutcome{}
		}
		request := "mw|" + normalized
		if body, ok := s.cacheGet(ctx, p.id, request); ok {
			if entries, err := parseMW(preset, body, query.Text); err == nil {
				return lookupOutcome{serves: true, entries: entries}
			}
		}
		body, err := s.mwGet(ctx, p, preset, query.Text)
		if err != nil {
			return lookupOutcome{serves: true, err: err}
		}
		entries, err := parseMW(preset, body, query.Text)
		if err != nil {
			return lookupOutcome{serves: true, err: err}
		}
		s.cachePut(ctx, p.id, request, body, len(entries) == 0)
		return lookupOutcome{serves: true, entries: entries}
	}

	status, err := s.customStatus(ctx, p, generation, false)
	if err != nil {
		return lookupOutcome{serves: true, err: err}
	}
	if !serves(status.Directions, query.From, query.To) {
		return lookupOutcome{}
	}
	request := "lookup|" + string(query.From) + "|" + string(query.To) + "|" + normalized
	if body, ok := s.cacheGet(ctx, p.id, request); ok {
		if entries, err := decodeLookup(body); err == nil {
			return lookupOutcome{serves: true, entries: entries}
		}
	}
	params := url.Values{}
	params.Set("q", query.Text)
	params.Set("from", string(query.From))
	params.Set("to", string(query.To))
	params.Set("limit", strconv.Itoa(MaxLimit))
	body, err := s.customGet(ctx, p, "lookup", params)
	if err != nil {
		return lookupOutcome{serves: true, err: err}
	}
	entries, err := decodeLookup(body)
	if err != nil {
		return lookupOutcome{serves: true, err: err}
	}
	s.cachePut(ctx, p.id, request, body, len(entries) == 0)
	return lookupOutcome{serves: true, entries: entries}
}

func decodeLookup(body []byte) ([]Entry, error) {
	var result Result
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("%w: response is not valid JSON", ErrUnavailable)
	}
	if result.Entries == nil {
		return []Entry{}, nil
	}
	return result.Entries, nil
}

func (s *Service) cacheGet(ctx context.Context, providerID int64, request string) ([]byte, bool) {
	body, ok, err := s.cache.Get(ctx, providerID, request, s.now())
	if err != nil {
		s.logger.WarnContext(ctx, "read dictionary cache", "provider", providerID, "error", err)
		return nil, false
	}
	return body, ok
}

func (s *Service) cachePut(ctx context.Context, providerID int64, request string, body []byte, empty bool) {
	if err := s.cache.Put(ctx, providerID, request, body, empty, s.now()); err != nil {
		s.logger.WarnContext(ctx, "write dictionary cache", "provider", providerID, "error", err)
	}
}

// mwGet fetches the raw Merriam-Webster response for word.
func (s *Service) mwGet(ctx context.Context, p storedProvider, preset Preset, word string) ([]byte, error) {
	if base, ok := s.presetBases[preset.Kind]; ok {
		preset.RequestBase = base
	}
	status, _, body, err := s.fetch(ctx, p, "lookup", mwRequestURL(preset, word, p.apiKey.String), "")
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		s.logger.WarnContext(ctx, "dictionary provider returned an error", "provider", p.id, "kind", p.kind, "status", status)
		return nil, fmt.Errorf("%w: remote status %d", ErrUnavailable, status)
	}
	return body, nil
}

// customGet calls GET {base}/{endpoint} of a custom provider and returns its JSON body.
func (s *Service) customGet(ctx context.Context, p storedProvider, endpoint string, params url.Values) ([]byte, error) {
	base, err := url.Parse(p.baseURL.String)
	if !p.baseURL.Valid || err != nil {
		s.logger.ErrorContext(ctx, "stored dictionary provider base URL is invalid", "provider", p.id)
		return nil, fmt.Errorf("%w: the configured base URL is invalid", ErrUnavailable)
	}
	endpointURL := base.JoinPath(endpoint)
	endpointURL.RawQuery = params.Encode()
	bearer := ""
	if p.apiKey.Valid {
		bearer = p.apiKey.String
	}
	status, contentType, body, err := s.fetch(ctx, p, endpoint, endpointURL.String(), bearer)
	if err != nil {
		return nil, err
	}
	if status == http.StatusBadRequest {
		if detail := problemDetail(body); detail != "" {
			return nil, fmt.Errorf("%w: %s", ErrInvalid, detail)
		}
		return nil, ErrInvalid
	}
	if status < 200 || status > 299 {
		s.logger.WarnContext(ctx, "dictionary provider returned an error", "provider", p.id, "endpoint", endpoint, "status", status)
		return nil, fmt.Errorf("%w: remote status %d", ErrUnavailable, status)
	}
	if !jsonMediaType(contentType) {
		return nil, fmt.Errorf("%w: response is not JSON", ErrUnavailable)
	}
	return body, nil
}

// fetch performs one GET request. Errors and logs never include the URL, which may carry an API key.
func (s *Service) fetch(ctx context.Context, p storedProvider, endpoint, rawURL, bearer string) (int, string, []byte, error) {
	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, "", nil, fmt.Errorf("%w: build request", ErrUnavailable)
	}
	request.Header.Set("Accept", "application/json")
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	response, err := s.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return 0, "", nil, ctx.Err()
		}
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		s.logger.WarnContext(ctx, "dictionary provider request failed", "provider", p.id, "kind", p.kind, "endpoint", endpoint, "error", err)
		return 0, "", nil, fmt.Errorf("%w: request failed", ErrUnavailable)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize+1))
	if err != nil {
		if ctx.Err() != nil {
			return 0, "", nil, ctx.Err()
		}
		s.logger.WarnContext(ctx, "dictionary provider response could not be read", "provider", p.id, "kind", p.kind, "endpoint", endpoint)
		return 0, "", nil, fmt.Errorf("%w: response could not be read", ErrUnavailable)
	}
	if len(body) > maxResponseSize {
		return 0, "", nil, fmt.Errorf("%w: response is too large", ErrUnavailable)
	}
	return response.StatusCode, response.Header.Get("Content-Type"), body, nil
}

func jsonMediaType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && (mediaType == "application/json" || strings.HasSuffix(mediaType, "+json"))
}

func problemDetail(body []byte) string {
	var problem struct {
		Detail string `json:"detail"`
	}
	if json.Unmarshal(body, &problem) != nil {
		return ""
	}
	detail := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, strings.TrimSpace(problem.Detail))
	if utf8.RuneCountInString(detail) > maxDetailRunes {
		detail = string([]rune(detail)[:maxDetailRunes]) + "…"
	}
	return detail
}
