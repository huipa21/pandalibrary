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
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"pandalibrary/internal/catalog"
)

const (
	requestTimeout  = 10 * time.Second
	maxResponseSize = 4 << 20
	statusCacheTTL  = 5 * time.Minute
	maxBaseURLBytes = 2048
	maxAPIKeyBytes  = 8192
	maxDetailRunes  = 300
)

// Service calls the administrator-configured online dictionary API and manages its settings.
type Service struct {
	writer *sql.DB
	reader *sql.DB
	logger *slog.Logger
	client *http.Client
	now    func() time.Time

	mu         sync.Mutex
	loaded     bool
	config     storedSettings
	generation uint64
	status     *Status
	statusAt   time.Time
}

type storedSettings struct {
	baseURL   sql.NullString
	apiKey    sql.NullString
	updatedAt int64
}

// NewService returns a dictionary service backed by the dictionary_settings table.
func NewService(writer, reader *sql.DB, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Service{writer: writer, reader: reader, logger: logger, client: &http.Client{}, now: time.Now}
}

func admin(viewer catalog.Viewer) error {
	if viewer.UserID < 1 || !viewer.IsAdmin {
		return catalog.ErrForbidden
	}
	return nil
}

func (c storedSettings) public() Settings {
	var base *string
	if c.baseURL.Valid {
		value := c.baseURL.String
		base = &value
	}
	return Settings{BaseURL: base, HasAPIKey: c.apiKey.Valid, UpdatedAt: time.UnixMilli(c.updatedAt).UTC()}
}

func loadSettings(ctx context.Context, database *sql.DB) (storedSettings, error) {
	var c storedSettings
	err := database.QueryRowContext(ctx,
		`SELECT base_url, api_key, updated_at FROM dictionary_settings WHERE id = 1`,
	).Scan(&c.baseURL, &c.apiKey, &c.updatedAt)
	if err != nil {
		return storedSettings{}, fmt.Errorf("load dictionary settings: %w", err)
	}
	return c, nil
}

// current returns the cached settings and their generation, loading them on first use.
func (s *Service) current(ctx context.Context) (storedSettings, uint64, error) {
	s.mu.Lock()
	if s.loaded {
		defer s.mu.Unlock()
		return s.config, s.generation, nil
	}
	generation := s.generation
	s.mu.Unlock()
	c, err := loadSettings(ctx, s.reader)
	if err != nil {
		return storedSettings{}, 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation == generation {
		s.config, s.loaded = c, true
	}
	return c, generation, nil
}

// Settings returns the public settings; the API key is never returned.
func (s *Service) Settings(ctx context.Context, viewer catalog.Viewer) (Settings, error) {
	if err := admin(viewer); err != nil {
		return Settings{}, err
	}
	c, _, err := s.current(ctx)
	if err != nil {
		return Settings{}, err
	}
	return c.public(), nil
}

// UpdateSettings applies a partial settings change and invalidates cached state.
func (s *Service) UpdateSettings(ctx context.Context, viewer catalog.Viewer, patch SettingsPatch) (Settings, error) {
	if err := admin(viewer); err != nil {
		return Settings{}, err
	}
	if !patch.BaseURL.Set && !patch.APIKey.Set {
		return Settings{}, fmt.Errorf("%w: no settings to update", ErrInvalid)
	}
	assignments := []string{}
	args := []any{}
	if patch.BaseURL.Set {
		var value sql.NullString
		if patch.BaseURL.Value != nil {
			if raw := strings.TrimSpace(*patch.BaseURL.Value); raw != "" {
				normalized, err := normalizeBaseURL(raw)
				if err != nil {
					return Settings{}, err
				}
				value = sql.NullString{String: normalized, Valid: true}
			}
		}
		assignments = append(assignments, "base_url = ?")
		args = append(args, value)
	}
	if patch.APIKey.Set {
		var value sql.NullString
		if patch.APIKey.Value != nil {
			key := strings.TrimSpace(*patch.APIKey.Value)
			if key == "" || len(key) > maxAPIKeyBytes || !utf8.ValidString(key) || strings.IndexFunc(key, unicode.IsSpace) >= 0 || strings.IndexFunc(key, unicode.IsControl) >= 0 {
				return Settings{}, fmt.Errorf("%w: the API key is invalid", ErrInvalid)
			}
			value = sql.NullString{String: key, Valid: true}
		}
		assignments = append(assignments, "api_key = ?")
		args = append(args, value)
	}
	assignments = append(assignments, "updated_at = ?")
	args = append(args, s.now().UnixMilli())

	s.mu.Lock()
	defer s.mu.Unlock()
	result, err := s.writer.ExecContext(ctx,
		"UPDATE dictionary_settings SET "+strings.Join(assignments, ", ")+" WHERE id = 1", args...)
	if err != nil {
		return Settings{}, fmt.Errorf("update dictionary settings: %w", err)
	}
	if rows, err := result.RowsAffected(); err != nil || rows != 1 {
		return Settings{}, errors.New("update dictionary settings: settings row is missing")
	}
	s.generation++
	s.loaded, s.status = false, nil
	c, err := loadSettings(ctx, s.writer)
	if err != nil {
		return Settings{}, err
	}
	s.config, s.loaded = c, true
	return c.public(), nil
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

// TestConnection fetches the remote status, bypassing and refreshing the cache.
func (s *Service) TestConnection(ctx context.Context, viewer catalog.Viewer) (Status, error) {
	if err := admin(viewer); err != nil {
		return Status{}, err
	}
	c, generation, err := s.current(ctx)
	if err != nil {
		return Status{}, err
	}
	if !c.baseURL.Valid {
		return Status{}, ErrNotConfigured
	}
	return s.fetchStatus(ctx, c, generation)
}

// Status reports the available lookup directions; it is empty when no API is configured.
func (s *Service) Status(ctx context.Context) (Status, error) {
	c, generation, err := s.current(ctx)
	if err != nil {
		return Status{}, err
	}
	if !c.baseURL.Valid {
		return Status{Directions: []Direction{}, Sources: []SourceInfo{}}, nil
	}
	s.mu.Lock()
	if s.status != nil && s.generation == generation && s.now().Sub(s.statusAt) < statusCacheTTL {
		cached := cloneStatus(*s.status)
		s.mu.Unlock()
		return cached, nil
	}
	s.mu.Unlock()
	return s.fetchStatus(ctx, c, generation)
}

func (s *Service) fetchStatus(ctx context.Context, c storedSettings, generation uint64) (Status, error) {
	var remote Status
	if err := s.get(ctx, c, "status", nil, &remote); err != nil {
		return Status{}, err
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
	s.mu.Lock()
	if s.generation == generation {
		cached := cloneStatus(status)
		s.status, s.statusAt = &cached, s.now()
	}
	s.mu.Unlock()
	return status, nil
}

func cloneStatus(status Status) Status {
	clone := Status{Directions: make([]Direction, len(status.Directions)), Sources: append([]SourceInfo{}, status.Sources...)}
	for i, direction := range status.Directions {
		direction.Sources = append([]string{}, direction.Sources...)
		clone.Directions[i] = direction
	}
	return clone
}

// Lookup validates the query locally and forwards it to the online API.
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
	c, _, err := s.current(ctx)
	if err != nil {
		return Result{}, err
	}
	if !c.baseURL.Valid {
		return Result{}, ErrNotConfigured
	}
	params := url.Values{}
	params.Set("q", query.Text)
	params.Set("from", string(query.From))
	params.Set("to", string(query.To))
	params.Set("limit", strconv.Itoa(query.Limit))
	var result Result
	if err := s.get(ctx, c, "lookup", params, &result); err != nil {
		return Result{}, err
	}
	if result.Query == "" {
		result.Query = query.Text
	}
	if result.From == "" {
		result.From = query.From
	}
	if result.To == "" {
		result.To = query.To
	}
	if result.Entries == nil {
		result.Entries = []Entry{}
	}
	if len(result.Entries) > query.Limit {
		result.Entries = result.Entries[:query.Limit]
	}
	for i := range result.Entries {
		if result.Entries[i].Definitions == nil {
			result.Entries[i].Definitions = []string{}
		}
	}
	return result, nil
}

func (s *Service) get(ctx context.Context, c storedSettings, endpoint string, params url.Values, target any) error {
	base, err := url.Parse(c.baseURL.String)
	if err != nil {
		s.logger.ErrorContext(ctx, "stored dictionary API base URL is invalid", "error", err)
		return fmt.Errorf("%w: the configured base URL is invalid", ErrUnavailable)
	}
	endpointURL := base.JoinPath(endpoint)
	endpointURL.RawQuery = params.Encode()

	requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, endpointURL.String(), nil)
	if err != nil {
		return fmt.Errorf("%w: build request", ErrUnavailable)
	}
	request.Header.Set("Accept", "application/json")
	if c.apiKey.Valid {
		request.Header.Set("Authorization", "Bearer "+c.apiKey.String)
	}
	response, err := s.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.logger.WarnContext(ctx, "dictionary API request failed", "endpoint", endpoint, "error", err)
		return fmt.Errorf("%w: request failed", ErrUnavailable)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseSize+1))
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.logger.WarnContext(ctx, "dictionary API response could not be read", "endpoint", endpoint, "error", err)
		return fmt.Errorf("%w: response could not be read", ErrUnavailable)
	}
	if len(body) > maxResponseSize {
		return fmt.Errorf("%w: response is too large", ErrUnavailable)
	}
	if response.StatusCode == http.StatusBadRequest {
		if detail := problemDetail(body); detail != "" {
			return fmt.Errorf("%w: %s", ErrInvalid, detail)
		}
		return ErrInvalid
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		s.logger.WarnContext(ctx, "dictionary API returned an error", "endpoint", endpoint, "status", response.StatusCode)
		return fmt.Errorf("%w: remote status %d", ErrUnavailable, response.StatusCode)
	}
	if !jsonMediaType(response.Header.Get("Content-Type")) {
		return fmt.Errorf("%w: response is not JSON", ErrUnavailable)
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("%w: response is not valid JSON", ErrUnavailable)
	}
	return nil
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
