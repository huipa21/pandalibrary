package dictionary

import (
	"strings"
	"unicode"
)

// deinflectEnglish returns possible base forms of a lowercase English word, such as
// "run" for "running" or "city" for "cities". Candidates are not checked against a
// dictionary and never include word itself.
func deinflectEnglish(word string) []string {
	for _, r := range word {
		if !unicode.IsLetter(r) && r != '\'' && r != '’' && r != '-' {
			return nil
		}
	}
	var out []string
	seen := map[string]bool{word: true}
	add := func(candidate string) {
		if len([]rune(candidate)) < 2 || seen[candidate] || strings.ContainsAny(candidate, "'’") {
			return
		}
		seen[candidate] = true
		out = append(out, candidate)
	}

	bases := []string{word}
	for _, suffix := range []string{"'s", "’s", "'", "’"} {
		if base, ok := strings.CutSuffix(word, suffix); ok && base != "" {
			if (suffix == "'" || suffix == "’") && !strings.HasSuffix(base, "s") {
				continue
			}
			bases = append(bases, base)
			add(base)
			break
		}
	}

	for _, base := range bases {
		if strings.ContainsAny(base, "'’") {
			continue
		}
		englishSuffixCandidates(base, add)
	}
	return out
}

func englishSuffixCandidates(word string, add func(string)) {
	if stem, ok := strings.CutSuffix(word, "ies"); ok && len(stem) >= 2 {
		add(stem + "y")
	}
	if stem, ok := strings.CutSuffix(word, "es"); ok && len(stem) >= 2 {
		add(stem)
	}
	if stem, ok := strings.CutSuffix(word, "s"); ok && !strings.HasSuffix(stem, "s") {
		add(stem)
	}

	if stem, ok := strings.CutSuffix(word, "ied"); ok && len(stem) >= 2 {
		add(stem + "y")
	}
	if stem, ok := strings.CutSuffix(word, "ed"); ok {
		add(stem)
		add(stem + "e")
		addUndoubled(stem, add)
		if strings.HasSuffix(stem, "ck") {
			add(strings.TrimSuffix(stem, "k"))
		}
	}

	if stem, ok := strings.CutSuffix(word, "ing"); ok && len(stem) >= 2 {
		if base, ok := strings.CutSuffix(stem, "y"); ok {
			add(base + "ie")
		}
		add(stem)
		add(stem + "e")
		addUndoubled(stem, add)
		if strings.HasSuffix(stem, "ck") {
			add(strings.TrimSuffix(stem, "k"))
		}
	}

	for _, suffix := range []string{"est", "er"} {
		stem, ok := strings.CutSuffix(word, suffix)
		if !ok || len(stem) < 2 {
			continue
		}
		if base, ok := strings.CutSuffix(stem, "i"); ok {
			add(base + "y")
		}
		add(stem)
		add(stem + "e")
		addUndoubled(stem, add)
	}
}

// addUndoubled adds stem without a final doubled consonant ("stopp" → "stop").
func addUndoubled(stem string, add func(string)) {
	n := len(stem)
	if n < 3 || stem[n-1] != stem[n-2] || stem[n-1] > unicode.MaxASCII {
		return
	}
	if strings.IndexByte("aeiouy", stem[n-1]) >= 0 {
		return
	}
	add(stem[:n-1])
}
