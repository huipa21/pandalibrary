package dictionary

// Merriam-Webster Collegiate Dictionary and Thesaurus adapters (dictionaryapi.com v3 JSON).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

const (
	mwMaxShortdefs = 8
	mwMaxExamples  = 2
	mwMaxSynonyms  = 15
	mwMaxRelated   = 10
	mwMaxLines     = 12
	mwAudioBase    = "https://media.merriam-webster.com/audio/prons/en/us/mp3/"
)

type mwEntry struct {
	Meta struct {
		ID    string     `json:"id"`
		Stems []string   `json:"stems"`
		Syns  [][]string `json:"syns"`
		Ants  [][]string `json:"ants"`
	} `json:"meta"`
	Hwi struct {
		Hw  string `json:"hw"`
		Prs []struct {
			Mw    string `json:"mw"`
			Sound struct {
				Audio string `json:"audio"`
			} `json:"sound"`
		} `json:"prs"`
	} `json:"hwi"`
	Fl       string            `json:"fl"`
	Def      []json.RawMessage `json:"def"`
	Et       []json.RawMessage `json:"et"`
	Suppl    json.RawMessage   `json:"suppl"`
	Shortdef []string          `json:"shortdef"`
}

// mwRequestURL returns the request URL for word: the preset RequestBase, the path-escaped
// word and ?key=<escaped key>.
func mwRequestURL(preset Preset, word, key string) string {
	return preset.RequestBase + url.PathEscape(word) + "?key=" + url.QueryEscape(key)
}

// parseMW maps a dictionaryapi.com response body to entries for query.
// A JSON array of strings (spelling suggestions) or an empty array yields no entries and nil error.
// A body that is not a JSON array (for example "Invalid API key...") is an ErrUnavailable error.
func parseMW(preset Preset, body []byte, query string) ([]Entry, error) {
	var items []json.RawMessage
	if err := json.Unmarshal(body, &items); err != nil {
		return nil, fmt.Errorf("%w: unexpected Merriam-Webster response %q", ErrUnavailable, mwSnippet(body))
	}
	query = strings.TrimSpace(query)
	var from, to Lang = English, English
	if len(preset.Directions) > 0 {
		from, to = preset.Directions[0].From, preset.Directions[0].To
	}
	thesaurus := preset.Kind == KindMWThesaurus
	var entries []Entry
	for _, item := range items {
		if len(entries) >= MaxLimit {
			break
		}
		item = bytes.TrimSpace(item)
		if len(item) == 0 || item[0] != '{' {
			continue // spelling suggestions are strings
		}
		var raw mwEntry
		if err := json.Unmarshal(item, &raw); err != nil {
			continue
		}
		entry, ok := mapMWEntry(raw, query, thesaurus)
		if !ok {
			continue
		}
		entry.From, entry.To = from, to
		entry.Source, entry.SourceName = preset.Kind, preset.Name
		entries = append(entries, entry)
	}
	return entries, nil
}

func mapMWEntry(raw mwEntry, query string, thesaurus bool) (Entry, bool) {
	id, _, _ := strings.Cut(raw.Meta.ID, ":")
	headword := strings.TrimSpace(strings.ReplaceAll(raw.Hwi.Hw, "*", ""))
	if headword == "" {
		headword = id
	}
	if headword == "" {
		return Entry{}, false
	}
	match := MatchLemma
	if strings.EqualFold(headword, query) || strings.EqualFold(id, query) {
		match = MatchExact
	} else {
		stem := false
		for _, s := range raw.Meta.Stems {
			if strings.EqualFold(strings.TrimSpace(s), query) {
				stem = true
				break
			}
		}
		if !stem {
			return Entry{}, false
		}
	}

	entry := Entry{Headword: headword, PartOfSpeech: cleanMW(raw.Fl), Match: match}
	var defs []string
	for _, def := range raw.Shortdef {
		if line := cleanMW(def); line != "" && len(defs) < mwMaxShortdefs {
			defs = append(defs, line)
		}
	}
	var sseq []any
	for _, def := range raw.Def {
		var value any
		if json.Unmarshal(def, &value) == nil {
			sseq = append(sseq, value)
		}
	}

	if thesaurus {
		if len(defs) == 0 {
			return Entry{}, false
		}
		if syns := mwWordList(raw.Meta.Syns, mwMaxSynonyms); syns != "" {
			defs = append(defs, "Synonyms: "+syns)
		}
		if ants := mwWordList(raw.Meta.Ants, mwMaxSynonyms); ants != "" {
			defs = append(defs, "Antonyms: "+ants)
		}
		var related [][]string
		mwWalk(sseq, func(key string, value any) {
			if key == "rel_list" {
				related = append(related, mwRelWords(value)...)
			}
		})
		if rel := mwWordList(related, mwMaxRelated); rel != "" {
			defs = append(defs, "Related: "+rel)
		}
	} else {
		if len(raw.Hwi.Prs) > 0 {
			entry.Reading = strings.TrimSpace(raw.Hwi.Prs[0].Mw)
			for _, pr := range raw.Hwi.Prs {
				if pr.Sound.Audio != "" {
					entry.AudioURL = mwAudioURL(pr.Sound.Audio)
					break
				}
			}
		}
		if len(defs) == 0 {
			// Entries without shortdef (for example some cross-references) may still define text.
			mwWalk(sseq, func(key string, value any) {
				if key != "dt" || len(defs) >= mwMaxShortdefs {
					return
				}
				for _, part := range mwPairs(value, "text") {
					if line := cleanMW(part); line != "" {
						defs = append(defs, line)
						break
					}
				}
			})
		}
		if len(defs) == 0 {
			return Entry{}, false
		}
		if et := mwEtymology(raw.Et); et != "" {
			defs = append(defs, "Etymology: "+et)
		}
		var examples []string
		mwWalk(sseq, func(key string, value any) {
			if key != "dt" {
				return
			}
			for _, vis := range mwPairsAny(value, "vis") {
				examples = append(examples, mwTexts(vis)...)
			}
		})
		if len(raw.Suppl) > 0 {
			var suppl struct {
				Examples []struct {
					T string `json:"t"`
				} `json:"examples"`
			}
			if json.Unmarshal(raw.Suppl, &suppl) == nil {
				for _, ex := range suppl.Examples {
					examples = append(examples, ex.T)
				}
			}
		}
		added := 0
		for _, ex := range examples {
			if added >= mwMaxExamples {
				break
			}
			if line := cleanMW(ex); line != "" {
				defs = append(defs, "Example: "+line)
				added++
			}
		}
	}
	if len(defs) > mwMaxLines {
		defs = defs[:mwMaxLines]
	}
	entry.Definitions = defs
	return entry, true
}

// mwWalk visits every object property in a decoded JSON value in a deterministic order.
func mwWalk(value any, visit func(key string, value any)) {
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			mwWalk(item, visit)
		}
	case map[string]any:
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			visit(key, v[key])
			mwWalk(v[key], visit)
		}
	}
}

// mwPairsAny returns the values of ["label", value] pairs in a dt-style array.
func mwPairsAny(value any, label string) []any {
	list, _ := value.([]any)
	var out []any
	for _, item := range list {
		pair, ok := item.([]any)
		if !ok || len(pair) < 2 {
			continue
		}
		if name, _ := pair[0].(string); name == label {
			out = append(out, pair[1])
		}
	}
	return out
}

func mwPairs(value any, label string) []string {
	var out []string
	for _, item := range mwPairsAny(value, label) {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// mwTexts returns the "t" strings of a vis list.
func mwTexts(value any) []string {
	list, _ := value.([]any)
	var out []string
	for _, item := range list {
		if object, ok := item.(map[string]any); ok {
			if text, ok := object["t"].(string); ok {
				out = append(out, text)
			}
		}
	}
	return out
}

func mwRelWords(value any) [][]string {
	groups, _ := value.([]any)
	var out [][]string
	for _, group := range groups {
		var words []string
		items, _ := group.([]any)
		for _, item := range items {
			if object, ok := item.(map[string]any); ok {
				if word, ok := object["wd"].(string); ok {
					words = append(words, word)
				}
			}
		}
		out = append(out, words)
	}
	return out
}

func mwEtymology(et []json.RawMessage) string {
	var parts []string
	for _, raw := range et {
		var pair []any
		if json.Unmarshal(raw, &pair) != nil || len(pair) < 2 {
			continue
		}
		if label, _ := pair[0].(string); label != "text" {
			continue
		}
		if text, ok := pair[1].(string); ok {
			if line := cleanMW(text); line != "" {
				parts = append(parts, line)
			}
		}
	}
	return strings.Join(parts, " ")
}

// mwWordList flattens, cleans and deduplicates word groups, keeping at most limit words.
func mwWordList(groups [][]string, limit int) string {
	seen := map[string]bool{}
	var words []string
	for _, group := range groups {
		for _, word := range group {
			word = cleanMW(word)
			key := strings.ToLower(word)
			if word == "" || seen[key] {
				continue
			}
			seen[key] = true
			words = append(words, word)
			if len(words) >= limit {
				return strings.Join(words, ", ")
			}
		}
	}
	return strings.Join(words, ", ")
}

var (
	mwAudioName  = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	mwLinkToken  = regexp.MustCompile(`\{(?:sx|a_link|d_link|i_link|et_link|mat|dxt)\|([^|}]*)[^}]*\}`)
	mwDateToken  = regexp.MustCompile(`\{ds\|[^}]*\}`)
	mwOtherToken = regexp.MustCompile(`\{[^}]*\}`)
	mwSpaces     = regexp.MustCompile(`\s+`)
)

// mwAudioURL builds the pronunciation recording URL, or "" for an unexpected audio name.
func mwAudioURL(audio string) string {
	if !mwAudioName.MatchString(audio) {
		return ""
	}
	var subdir string
	switch first := rune(audio[0]); {
	case strings.HasPrefix(audio, "bix"):
		subdir = "bix"
	case strings.HasPrefix(audio, "gg"):
		subdir = "gg"
	case unicode.IsDigit(first) || first == '_':
		subdir = "number"
	default:
		subdir = strings.ToLower(string(first))
	}
	return mwAudioBase + subdir + "/" + audio + ".mp3"
}

// cleanMW strips Merriam-Webster markup tokens and collapses whitespace.
func cleanMW(text string) string {
	text = strings.TrimSpace(text)
	text = strings.TrimPrefix(text, "{bc}")
	text = strings.ReplaceAll(text, "{bc}", ": ")
	text = strings.ReplaceAll(text, "{ldquo}", "\u201c")
	text = strings.ReplaceAll(text, "{rdquo}", "\u201d")
	text = mwDateToken.ReplaceAllString(text, "")
	text = mwLinkToken.ReplaceAllString(text, "$1")
	text = mwOtherToken.ReplaceAllString(text, "")
	text = mwSpaces.ReplaceAllString(text, " ")
	return strings.TrimSpace(text)
}

// mwSnippet returns a short printable excerpt of an unexpected body for error messages.
func mwSnippet(body []byte) string {
	var b strings.Builder
	for _, r := range string(body) {
		if b.Len() >= 60 {
			b.WriteString("…")
			break
		}
		if unicode.IsPrint(r) {
			b.WriteRune(r)
		} else {
			b.WriteRune(' ')
		}
	}
	return strings.TrimSpace(b.String())
}
