package dictionary

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// NormalizeKey is the single normalization used for stored keys and lookups.
// It applies NFKC, trims surrounding punctuation/symbols/spaces, collapses inner
// whitespace and lowercases. Callers convert Chinese to Simplified first and
// Japanese readings with KatakanaToHiragana when a reading key is wanted.
func NormalizeKey(_ Lang, value string) string {
	value = norm.NFKC.String(value)
	value = strings.TrimFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) || unicode.IsControl(r)
	})
	value = strings.Join(strings.Fields(value), " ")
	return strings.ToLower(value)
}

// KatakanaToHiragana maps full-width katakana letters to hiragana and leaves other runes.
func KatakanaToHiragana(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'ァ' && r <= 'ヶ' {
			return r - 0x60
		}
		return r
	}, value)
}

// Simplifier converts Traditional Chinese text to Simplified Chinese with a greedy
// longest match over the zh_t2s table. Unknown runes are kept.
type Simplifier struct {
	mapping map[string]string
	maxLen  int
}

// NewSimplifier builds a converter from traditional→simplified pairs.
func NewSimplifier(pairs map[string]string) *Simplifier {
	s := &Simplifier{mapping: make(map[string]string, len(pairs)), maxLen: 1}
	for trad, simp := range pairs {
		if trad == "" || trad == simp {
			continue
		}
		s.mapping[trad] = simp
		s.maxLen = max(s.maxLen, utf8.RuneCountInString(trad))
	}
	return s
}

// LoadSimplifier reads zh_t2s. An empty table yields a converter that changes nothing.
func LoadSimplifier(ctx context.Context, database *sql.DB) (*Simplifier, error) {
	rows, err := database.QueryContext(ctx, `SELECT trad, simp FROM zh_t2s`)
	if err != nil {
		return nil, fmt.Errorf("load Chinese variants: %w", err)
	}
	defer rows.Close()
	pairs := map[string]string{}
	for rows.Next() {
		var trad, simp string
		if err := rows.Scan(&trad, &simp); err != nil {
			return nil, fmt.Errorf("read Chinese variant: %w", err)
		}
		pairs[trad] = simp
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read Chinese variants: %w", err)
	}
	return NewSimplifier(pairs), nil
}

// Len reports how many mappings are loaded.
func (s *Simplifier) Len() int {
	if s == nil {
		return 0
	}
	return len(s.mapping)
}

// Simplify returns value in Simplified Chinese.
func (s *Simplifier) Simplify(value string) string {
	if s == nil || len(s.mapping) == 0 {
		return value
	}
	runes := []rune(value)
	var out strings.Builder
	out.Grow(len(value))
	for index := 0; index < len(runes); {
		matched := false
		for size := min(s.maxLen, len(runes)-index); size > 0; size-- {
			if simp, ok := s.mapping[string(runes[index:index+size])]; ok {
				out.WriteString(simp)
				index += size
				matched = true
				break
			}
		}
		if !matched {
			out.WriteRune(runes[index])
			index++
		}
	}
	return out.String()
}
