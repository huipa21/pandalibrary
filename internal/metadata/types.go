package metadata

import (
	"context"
	"errors"
	"time"

	"pandalibrary/internal/catalog"
)

var (
	ErrInvalid  = errors.New("invalid metadata request")
	ErrNotFound = errors.New("metadata candidate not found")
	ErrConflict = errors.New("metadata candidate is no longer available")
)

// Provider searches for normalized book records and retrieves a record by reference.
type Provider interface {
	Name() string
	Search(context.Context, Query) ([]Candidate, error)
	Get(context.Context, string) (*Candidate, error)
}

// Query is either an ISBN or a title with an optional first author and language.
type Query struct {
	ISBN     string `json:"isbn,omitempty"`
	Title    string `json:"title,omitempty"`
	Author   string `json:"author,omitempty"`
	Language string `json:"language,omitempty"`
}

// Person is a contributor and their catalog role.
type Person struct {
	Name string `json:"name"`
	Role string `json:"role"`
}

// Series is a series name with an optional position.
type Series struct {
	Name  string   `json:"name"`
	Index *float64 `json:"index"`
}

// Identifier is a recognized bibliographic identifier.
type Identifier struct {
	Scheme string `json:"scheme"`
	Value  string `json:"value"`
}

// Candidate is a provider record in the common metadata representation.
type Candidate struct {
	Provider      string       `json:"provider"`
	Reference     string       `json:"reference"`
	Title         string       `json:"title"`
	Subtitle      *string      `json:"subtitle"`
	Authors       []Person     `json:"authors"`
	Description   *string      `json:"description"`
	Publisher     *string      `json:"publisher"`
	PublishedDate *string      `json:"published_date"`
	Language      *string      `json:"language"`
	PageCount     *int64       `json:"page_count"`
	Series        *Series      `json:"series"`
	Tags          []string     `json:"tags"`
	Identifiers   []Identifier `json:"identifiers"`
	CoverURL      *string      `json:"cover_url"`
}

// ProviderSettings omits the write-only token.
type ProviderSettings struct {
	Provider  string    `json:"provider"`
	Enabled   bool      `json:"enabled"`
	Priority  int64     `json:"priority"`
	BaseURL   *string   `json:"base_url"`
	HasToken  bool      `json:"has_token"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ProviderPatch distinguishes absent properties from explicit nulls.
type ProviderPatch struct {
	Enabled  catalog.Optional[bool]   `json:"enabled"`
	Priority catalog.Optional[int64]  `json:"priority"`
	BaseURL  catalog.Optional[string] `json:"base_url"`
	APIToken catalog.Optional[string] `json:"api_token"`
}

// LookupError is a sanitized failure for one provider.
type LookupError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ProviderResult retains successes when other providers fail.
type ProviderResult struct {
	Provider   string       `json:"provider"`
	Candidates []Candidate  `json:"candidates"`
	Error      *LookupError `json:"error"`
}

// Selection identifies the cached candidate whose value is chosen for a field.
type Selection struct {
	Provider  string `json:"provider"`
	Reference string `json:"reference"`
}

// ApplyRequest chooses cached provider fields and optionally edits other fields manually.
type ApplyRequest struct {
	RequestKey string               `json:"request_key"`
	Fields     map[string]Selection `json:"fields"`
	Patch      catalog.BookPatch    `json:"patch,omitempty"`
}

// LookupResponse binds subsequent selections to this book's cached lookup.
type LookupResponse struct {
	RequestKey string           `json:"request_key"`
	Query      Query            `json:"query"`
	Providers  []ProviderResult `json:"providers"`
}

// CoverRequest identifies a cover without accepting a caller-supplied URL.
type CoverRequest struct {
	RequestKey string `json:"request_key"`
	Selection
}
