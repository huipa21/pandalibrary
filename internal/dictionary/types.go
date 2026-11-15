// Package dictionary stores imported word dictionaries in a separate SQLite file
// and answers selection lookups between English, Simplified Chinese and Japanese.
package dictionary

import (
	"errors"
	"path/filepath"
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

// Key kinds stored in entry_keys.kind.
const (
	KeyHeadword = "headword"
	KeyReading  = "reading"
	KeyVariant  = "variant"
	KeyForm     = "form" // an inflected form that leads to the entry's lemma
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
	From         Lang      `json:"from,omitempty"`
	To           Lang      `json:"to,omitempty"`
	Source       string    `json:"source"`
	SourceName   string    `json:"sourceName"`
	Headword     string    `json:"headword"`
	Reading      string    `json:"reading,omitempty"`
	PartOfSpeech string    `json:"partOfSpeech,omitempty"`
	Definitions  []string  `json:"definitions"`
	Match        MatchKind `json:"match"`
}

// Result is the response to one lookup.
type Result struct {
	Query   string  `json:"query"`
	Term    string  `json:"term"`
	From    Lang    `json:"from"`
	To      Lang    `json:"to"`
	Entries []Entry `json:"entries"`
}

// Direction is an installed lookup direction and the sources that serve it.
type Direction struct {
	From    Lang     `json:"from"`
	To      Lang     `json:"to"`
	Sources []string `json:"sources"`
}

// SourceInfo describes one imported source.
type SourceInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	License    string `json:"license"`
	URL        string `json:"url"`
	Entries    int64  `json:"entries"`
	ImportedAt int64  `json:"importedAt"` // Unix milliseconds
}

// Status lists installed directions and sources.
type Status struct {
	Directions []Direction  `json:"directions"`
	Sources    []SourceInfo `json:"sources"`
}

// SourceSpec is static metadata for a supported source.
type SourceSpec struct {
	ID      string
	Name    string
	License string
	URL     string
}

// Supported source IDs.
const (
	SourceECDICT       = "ecdict"
	SourceCEDICT       = "cc-cedict"
	SourceJMdict       = "jmdict"
	SourceWiktionaryEN = "wiktionary-en"
	SourceWiktionaryZH = "wiktionary-zh"
	SourceWiktionaryJA = "wiktionary-ja"
)

// Sources is the registry of supported sources. Earlier sources rank first among equal matches.
var Sources = []SourceSpec{
	{SourceECDICT, "ECDICT", "MIT", "https://github.com/skywind3000/ECDICT"},
	{SourceCEDICT, "CC-CEDICT", "CC BY-SA 4.0", "https://www.mdbg.net/chinese/dictionary?page=cc-cedict"},
	{SourceJMdict, "JMdict", "CC BY-SA 4.0 (EDRDG)", "https://www.edrdg.org/jmdict/j_jmdict.html"},
	{SourceWiktionaryEN, "English Wiktionary (Kaikki)", "CC BY-SA 4.0 / GFDL", "https://kaikki.org/dictionary/rawdata.html"},
	{SourceWiktionaryZH, "Chinese Wiktionary (Kaikki)", "CC BY-SA 4.0 / GFDL", "https://kaikki.org/zhwiktionary/rawdata.html"},
	{SourceWiktionaryJA, "Japanese Wiktionary (Kaikki)", "CC BY-SA 4.0 / GFDL", "https://kaikki.org/jawiktionary/rawdata.html"},
}

// SourceByID returns the registry entry for id and its ranking position.
func SourceByID(id string) (SourceSpec, int, bool) {
	for index, spec := range Sources {
		if spec.ID == id {
			return spec, index, true
		}
	}
	return SourceSpec{}, 0, false
}

// DefaultPath is the dictionary database location inside the data directory.
func DefaultPath(dataDir string) string {
	return filepath.Join(dataDir, "dictionaries", "dictionaries.db")
}
