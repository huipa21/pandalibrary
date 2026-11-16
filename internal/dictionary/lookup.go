package dictionary

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	// maxKeysPerQuery keeps IN lists well below SQLite's variable limit.
	maxKeysPerQuery = 400
	// maxRowsPerQuery caps rows fetched for one batch of keys.
	maxRowsPerQuery = 2000
	// maxPrefixRunes bounds how long a selection prefix may be when searching for a word.
	maxPrefixRunes = 24
	// maxDeinflectPrefixRunes bounds prefixes that are also deinflected (Japanese).
	maxDeinflectPrefixRunes = 16
)

// Lookup finds entries for q.Text in the q.From→q.To direction.
func (s *Store) Lookup(ctx context.Context, q Query) (Result, error) {
	query, err := validateQuery(q)
	if err != nil {
		return Result{}, err
	}
	result := Result{Query: query.Text, From: query.From, To: query.To, Entries: []Entry{}}
	database, simplifier, _, err := s.acquire(ctx)
	if err != nil {
		return Result{}, err
	}
	keys := lookupKeys(query.From, query.Text, simplifier)
	if len(keys) == 0 {
		return result, nil
	}
	result.Term = keys[0]
	if database == nil {
		return result, nil
	}
	entries, term, err := s.find(ctx, database, query, keys)
	if err != nil {
		return Result{}, fmt.Errorf("look up %q: %w", query.Text, err)
	}
	if len(entries) > 0 {
		result.Entries = entries
		result.Term = term
	}
	return result, nil
}

func validateQuery(q Query) (Query, error) {
	q.Text = strings.TrimSpace(q.Text)
	if q.Text == "" {
		return Query{}, fmt.Errorf("%w: text to look up is required", ErrInvalid)
	}
	if utf8.RuneCountInString(q.Text) > MaxQueryRunes {
		return Query{}, fmt.Errorf("%w: text to look up must be at most %d characters", ErrInvalid, MaxQueryRunes)
	}
	from, ok := ParseLang(string(q.From))
	if !ok {
		return Query{}, fmt.Errorf("%w: unsupported source language %q", ErrInvalid, q.From)
	}
	to, ok := ParseLang(string(q.To))
	if !ok {
		return Query{}, fmt.Errorf("%w: unsupported target language %q", ErrInvalid, q.To)
	}
	switch {
	case q.Limit == 0:
		q.Limit = DefaultLimit
	case q.Limit < 1 || q.Limit > MaxLimit:
		return Query{}, fmt.Errorf("%w: limit must be between 1 and %d", ErrInvalid, MaxLimit)
	}
	q.From, q.To = from, to
	return q, nil
}

// lookupKeys returns the normalized keys for text, preferred key first.
func lookupKeys(lang Lang, text string, simplifier *Simplifier) []string {
	switch lang {
	case Chinese:
		return uniqueNonEmpty(NormalizeKey(lang, simplifier.Simplify(text)))
	case Japanese:
		key := NormalizeKey(lang, text)
		return uniqueNonEmpty(key, KatakanaToHiragana(key))
	default:
		return uniqueNonEmpty(NormalizeKey(lang, text))
	}
}

type keyHit struct {
	key         string
	kind        string
	id          int64
	source      string
	headword    string
	reading     string
	pos         string
	definitions string
	rank        int64
}

func (s *Store) find(ctx context.Context, database *sql.DB, q Query, keys []string) ([]Entry, string, error) {
	hits, err := searchKeys(ctx, database, q.From, q.To, keys)
	if err != nil {
		return nil, "", err
	}
	if len(hits) > 0 {
		entries, term := s.buildEntries(hits, nil, q.Limit)
		return entries, term, nil
	}

	lemmas := deinflectAll(q.From, keys)
	if len(lemmas) > 0 {
		hits, err = searchKeys(ctx, database, q.From, q.To, lemmas)
		if err != nil {
			return nil, "", err
		}
		if len(hits) > 0 {
			match := MatchLemma
			entries, term := s.buildEntries(hits, &match, q.Limit)
			return entries, term, nil
		}
	}

	weights := prefixCandidates(q.From, keys)
	if len(weights) == 0 {
		return nil, "", nil
	}
	candidates := make([]string, 0, len(weights))
	for key := range weights {
		candidates = append(candidates, key)
	}
	slices.Sort(candidates)
	hits, err = searchKeys(ctx, database, q.From, q.To, candidates)
	if err != nil {
		return nil, "", err
	}
	best := 0
	for _, hit := range hits {
		best = max(best, weights[hit.key])
	}
	hits = slices.DeleteFunc(hits, func(hit keyHit) bool { return weights[hit.key] != best })
	match := MatchPrefix
	entries, term := s.buildEntries(hits, &match, q.Limit)
	return entries, term, nil
}

func searchKeys(ctx context.Context, database *sql.DB, from, to Lang, keys []string) ([]keyHit, error) {
	var hits []keyHit
	for chunk := range slices.Chunk(keys, maxKeysPerQuery) {
		args := make([]any, 0, len(chunk)+3)
		args = append(args, string(from), string(to))
		for _, key := range chunk {
			args = append(args, key)
		}
		args = append(args, maxRowsPerQuery)
		rows, err := database.QueryContext(ctx,
			`SELECT k.key, k.kind, e.id, e.source_id, e.headword, e.reading, e.pos, e.definitions, e.rank
			FROM entry_keys AS k JOIN entries AS e ON e.id = k.entry_id
			WHERE k.from_lang = ? AND k.to_lang = ? AND lower(trim(e.pos)) != 'romanization'
			AND k.key IN (?`+strings.Repeat(", ?", len(chunk)-1)+`)
			ORDER BY e.rank, e.id LIMIT ?`, args...)
		if err != nil {
			return nil, fmt.Errorf("query dictionary keys: %w", err)
		}
		for rows.Next() {
			var hit keyHit
			if err := rows.Scan(&hit.key, &hit.kind, &hit.id, &hit.source, &hit.headword, &hit.reading,
				&hit.pos, &hit.definitions, &hit.rank); err != nil {
				rows.Close()
				return nil, fmt.Errorf("read dictionary entry: %w", err)
			}
			hits = append(hits, hit)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, fmt.Errorf("query dictionary keys: %w", err)
		}
	}
	return hits, nil
}

// buildEntries merges hits per entry, orders them and applies limit. When match is nil
// the match kind follows the key kind (form keys are lemma matches).
func (s *Store) buildEntries(hits []keyHit, match *MatchKind, limit int) ([]Entry, string) {
	type ranked struct {
		hit   keyHit
		match MatchKind
	}
	byID := map[int64]ranked{}
	for _, hit := range hits {
		kind := MatchExact
		if match != nil {
			kind = *match
		} else if hit.kind == KeyForm {
			kind = MatchLemma
		}
		current, seen := byID[hit.id]
		if !seen || matchOrder(kind) < matchOrder(current.match) ||
			(kind == current.match && hit.key < current.hit.key) {
			byID[hit.id] = ranked{hit: hit, match: kind}
		}
	}
	list := make([]ranked, 0, len(byID))
	for _, item := range byID {
		list = append(list, item)
	}
	slices.SortFunc(list, func(a, b ranked) int {
		return cmp.Or(
			cmp.Compare(matchOrder(a.match), matchOrder(b.match)),
			cmp.Compare(sourceOrder(a.hit.source), sourceOrder(b.hit.source)),
			strings.Compare(a.hit.source, b.hit.source),
			cmp.Compare(a.hit.rank, b.hit.rank),
			cmp.Compare(a.hit.id, b.hit.id),
		)
	})
	if len(list) > limit {
		list = list[:limit]
	}
	entries := make([]Entry, 0, len(list))
	for _, item := range list {
		definitions := []string{}
		if err := json.Unmarshal([]byte(item.hit.definitions), &definitions); err != nil || definitions == nil {
			if err != nil {
				s.logger.Warn("invalid dictionary definitions", "entry", item.hit.id, "source", item.hit.source, "error", err)
			}
			definitions = []string{}
		}
		entries = append(entries, Entry{
			Source:       item.hit.source,
			SourceName:   sourceName(item.hit.source),
			Headword:     item.hit.headword,
			Reading:      item.hit.reading,
			PartOfSpeech: item.hit.pos,
			Definitions:  definitions,
			Match:        item.match,
		})
	}
	term := ""
	if len(list) > 0 {
		term = list[0].hit.key
	}
	return entries, term
}

func matchOrder(kind MatchKind) int {
	switch kind {
	case MatchExact:
		return 0
	case MatchLemma:
		return 1
	default:
		return 2
	}
}

// deinflect returns dictionary-form candidates for an inflected key.
func deinflect(lang Lang, key string) []string {
	switch lang {
	case English:
		return deinflectEnglish(key)
	case Japanese:
		return deinflectJapanese(key)
	}
	return nil
}

func deinflectAll(lang Lang, keys []string) []string {
	var out []string
	for _, key := range keys {
		out = append(out, deinflect(lang, key)...)
	}
	out = uniqueNonEmpty(out...)
	return slices.DeleteFunc(out, func(candidate string) bool { return slices.Contains(keys, candidate) })
}

// prefixCandidates maps candidate keys to the length of the selection prefix they
// stand for; the longest prefix with any match wins.
func prefixCandidates(lang Lang, keys []string) map[string]int {
	weights := map[string]int{}
	add := func(key string, weight int) {
		key = NormalizeKey(lang, key)
		if key != "" && weight > weights[key] {
			weights[key] = weight
		}
	}
	for _, key := range keys {
		if lang == English {
			words := strings.FieldsFunc(key, func(r rune) bool {
				return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '\'' && r != '’' && r != '-'
			})
			if len(words) == 0 {
				continue
			}
			if len(words) == 1 && words[0] == key {
				continue
			}
			for count := min(len(words), 8); count >= 1; count-- {
				if count == len(words) && strings.Join(words, " ") == key {
					continue
				}
				add(strings.Join(words[:count], " "), count*2)
			}
			for _, lemma := range deinflectEnglish(words[0]) {
				add(lemma, 1)
			}
			continue
		}
		runes := []rune(key)
		if len(runes) < 2 {
			continue
		}
		for size := min(len(runes)-1, maxPrefixRunes); size >= 1; size-- {
			prefix := string(runes[:size])
			add(prefix, size*2)
			if lang == Japanese && size <= maxDeinflectPrefixRunes {
				for _, lemma := range deinflectJapanese(prefix) {
					add(lemma, size*2-1)
				}
			}
		}
	}
	for _, key := range keys {
		delete(weights, key)
	}
	return weights
}

func uniqueNonEmpty(values ...string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" && !slices.Contains(out, value) {
			out = append(out, value)
		}
	}
	return out
}
