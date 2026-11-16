// Package dictionary answers selection lookups between English, Simplified Chinese
// and Japanese through an administrator-configured online dictionary API.
package dictionary

import (
	"errors"
	"time"

	"pandalibrary/internal/catalog"
)

// Lang is a supported dictionary language. Chinese is always Simplified Chinese.
type Lang string

const (
	English  Lang = "en"
	Chinese  Lang = "zh"
	Japanese Lang = "ja"
)

// Languages lists every supported language in display order.
var Languages = []Lang{English, Chinese, Japanese}

// ParseLang accepts only the supported language codes.
func ParseLang(value string) (Lang, bool) {
	switch Lang(value) {
	case English, Chinese, Japanese:
		return Lang(value), true
	}
	return "", false
}

const (
	MaxQueryRunes = 64
	DefaultLimit  = 20
	MaxLimit      = 50
)

// ErrInvalid marks a rejected lookup request; its message is safe to show to clients.
var ErrInvalid = errors.New("invalid dictionary request")

// ErrUnavailable marks a failed call to the online dictionary API.
var ErrUnavailable = errors.New("dictionary API is unavailable")

// ErrNotConfigured marks a lookup or test for which no enabled, usable provider exists.
var ErrNotConfigured = errors.New("dictionary API is not configured")

// ErrNotFound marks an unknown provider ID.
var ErrNotFound = errors.New("dictionary provider not found")

// MatchKind explains how a lookup reached an entry.
type MatchKind string

const (
	// MatchExact matches the headword, a reading or a script variant of it.
	MatchExact MatchKind = "exact"
	// MatchLemma matches after reducing an inflected form to its dictionary form.
	MatchLemma MatchKind = "lemma"
	// MatchPrefix matches the longest dictionary word at the start of the selection.
	MatchPrefix MatchKind = "prefix"
)

// Query is one lookup request.
type Query struct {
	Text  string
	From  Lang
	To    Lang
	Limit int
}

// Entry is one dictionary entry in a lookup result.
type Entry struct {
	From              Lang      `json:"from,omitempty"`
	To                Lang      `json:"to,omitempty"`
	Source            string    `json:"source"`
	SourceName        string    `json:"sourceName"`
	Headword          string    `json:"headword"`
	Reading           string    `json:"reading,omitempty"`
	PartOfSpeech      string    `json:"partOfSpeech,omitempty"`
	Definitions       []string  `json:"definitions"`
	HiddenDefinitions []string  `json:"hiddenDefinitions,omitempty"`
	AudioURL          string    `json:"audioUrl,omitempty"` // https pronunciation recording
	Match             MatchKind `json:"match"`
}

// Result is the response to one lookup.
type Result struct {
	Query   string  `json:"query"`
	Term    string  `json:"term"`
	From    Lang    `json:"from"`
	To      Lang    `json:"to"`
	Entries []Entry `json:"entries"`
}

// Direction is an available lookup direction and the sources that serve it.
type Direction struct {
	From    Lang     `json:"from"`
	To      Lang     `json:"to"`
	Sources []string `json:"sources"`
}

// SourceInfo describes one dictionary source reported by the online API.
type SourceInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	License    string `json:"license"`
	URL        string `json:"url"`
	Entries    int64  `json:"entries"`
	ImportedAt int64  `json:"importedAt"` // Unix milliseconds
}

// Status lists available directions and sources.
type Status struct {
	Directions []Direction  `json:"directions"`
	Sources    []SourceInfo `json:"sources"`
}

// Provider kinds stored in dictionary_providers.kind.
const (
	KindMWCollegiate = "mw-collegiate"
	KindMWThesaurus  = "mw-thesaurus"
	// KindCustom speaks PandaLibrary's own JSON protocol: GET {base}/status and GET {base}/lookup.
	KindCustom = "custom"
)

// Preset is a built-in provider that only needs an API key.
type Preset struct {
	Kind        string
	Name        string
	SignupURL   string
	Directions  []Direction // Sources holds the entry source ID the preset reports
	RequestBase string      // the word and ?key= are appended
}

// Presets are seeded by migration and cannot be deleted; both serve English → English.
var Presets = []Preset{
	{
		Kind: KindMWCollegiate, Name: "Merriam-Webster's Collegiate Dictionary", SignupURL: "https://dictionaryapi.com/register/index",
		Directions:  []Direction{{From: English, To: English, Sources: []string{KindMWCollegiate}}},
		RequestBase: "https://www.dictionaryapi.com/api/v3/references/collegiate/json/",
	},
	{
		Kind: KindMWThesaurus, Name: "Merriam-Webster's Collegiate Thesaurus", SignupURL: "https://dictionaryapi.com/register/index",
		Directions:  []Direction{{From: English, To: English, Sources: []string{KindMWThesaurus}}},
		RequestBase: "https://www.dictionaryapi.com/api/v3/references/thesaurus/json/",
	},
}

// PresetByKind returns the preset for kind.
func PresetByKind(kind string) (Preset, bool) {
	for _, preset := range Presets {
		if preset.Kind == kind {
			return preset, true
		}
	}
	return Preset{}, false
}

// Provider is the administrator view of one online dictionary; the API key is write-only.
type Provider struct {
	ID        int64   `json:"id"`
	Kind      string  `json:"kind"`
	Name      string  `json:"name"`
	Preset    bool    `json:"preset"`
	SignupURL string  `json:"signup_url,omitempty"`
	BaseURL   *string `json:"base_url"`
	HasAPIKey bool    `json:"has_api_key"`
	Enabled   bool    `json:"enabled"`
	Priority  int64   `json:"priority"`
	// Directions are static for presets and the last known remote status for custom providers.
	Directions []Direction `json:"directions"`
	UpdatedAt  time.Time   `json:"updated_at"`
}

// Providers is the administrator overview of configured providers and the lookup cache.
type Providers struct {
	Providers    []Provider `json:"providers"`
	CacheEntries int64      `json:"cache_entries"`
}

// ProviderInput creates a custom provider.
type ProviderInput struct {
	Name     string  `json:"name"`
	BaseURL  string  `json:"base_url"`
	APIKey   *string `json:"api_key"`
	Priority *int64  `json:"priority"`
}

// ProviderPatch distinguishes absent properties from explicit nulls, which clear a value.
// Setting an API key on a disabled preset enables it unless enabled is also sent;
// clearing a preset's key disables it.
type ProviderPatch struct {
	Name     catalog.Optional[string] `json:"name"`
	BaseURL  catalog.Optional[string] `json:"base_url"`
	APIKey   catalog.Optional[string] `json:"api_key"`
	Enabled  catalog.Optional[bool]   `json:"enabled"`
	Priority catalog.Optional[int64]  `json:"priority"`
}
