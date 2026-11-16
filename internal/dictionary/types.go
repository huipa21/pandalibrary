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

// ErrNotConfigured marks a lookup attempted before an administrator set the API address.
var ErrNotConfigured = errors.New("dictionary API is not configured")

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

// Settings is the administrator view of the online dictionary API; the key is write-only.
type Settings struct {
	BaseURL   *string   `json:"base_url"`
	HasAPIKey bool      `json:"has_api_key"`
	UpdatedAt time.Time `json:"updated_at"`
}

// SettingsPatch distinguishes absent properties from explicit nulls, which clear a value.
type SettingsPatch struct {
	BaseURL catalog.Optional[string] `json:"base_url"`
	APIKey  catalog.Optional[string] `json:"api_key"`
}
