package dictimport

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"

	"pandalibrary/internal/dictionary"
)

// wiktextractLangCodes maps accepted lang_code values to dictionary languages.
var wiktextractLangCodes = map[string]dictionary.Lang{
	"en":  dictionary.English,
	"eng": dictionary.English,
	"zh":  dictionary.Chinese,
	"cmn": dictionary.Chinese,
	"zho": dictionary.Chinese,
	"chi": dictionary.Chinese,
	"ja":  dictionary.Japanese,
	"jpn": dictionary.Japanese,
}

// wiktextractPatterns are cheap substring checks run before a line is unmarshalled.
var wiktextractPatterns = func() [][]byte {
	var patterns [][]byte
	for code := range wiktextractLangCodes {
		patterns = append(patterns,
			[]byte(`"lang_code": "`+code+`"`),
			[]byte(`"lang_code":"`+code+`"`))
	}
	return patterns
}()

// wiktextractSkippedFormTags marks forms that are not words a reader would select.
var wiktextractSkippedFormTags = []string{"romanization", "table-tags", "inflection-template", "class", "transliteration"}

type wiktextractEntry struct {
	Word     string `json:"word"`
	LangCode string `json:"lang_code"`
	POS      string `json:"pos"`
	Senses   []struct {
		Glosses []string `json:"glosses"`
		Tags    []string `json:"tags"`
	} `json:"senses"`
	Forms []struct {
		Form string   `json:"form"`
		Tags []string `json:"tags"`
	} `json:"forms"`
	Sounds []struct {
		ZhPron string   `json:"zh-pron"`
		Pinyin string   `json:"pinyin"`
		Other  string   `json:"other"`
		Tags   []string `json:"tags"`
	} `json:"sounds"`
}

// wiktextractParser reads Kaikki wiktextract JSONL. The edition language is the gloss language;
// only English, Chinese and Japanese words are kept.
func wiktextractParser(edition dictionary.Lang) parser {
	return func(ctx context.Context, input io.Reader, w *writer) error {
		if edition == dictionary.Chinese && w.simplifier.Len() == 0 {
			w.warnOnce("t2s", "zh_t2s is empty: Chinese text is stored without Traditional→Simplified conversion; import cc-cedict first and re-import this source")
		}
		reader, ok := input.(*bufio.Reader)
		if !ok {
			reader = bufio.NewReaderSize(input, 1<<20)
		}
		var long []byte
		for lineNumber := 1; ; lineNumber++ {
			line, err := reader.ReadSlice('\n')
			if errors.Is(err, bufio.ErrBufferFull) {
				long = append(long[:0], line...)
				for errors.Is(err, bufio.ErrBufferFull) {
					line, err = reader.ReadSlice('\n')
					long = append(long, line...)
				}
				line = long
			}
			if err != nil && !errors.Is(err, io.EOF) {
				return fmt.Errorf("read wiktextract line %d: %w", lineNumber, err)
			}
			if len(line) > 0 && wiktextractCandidate(line) {
				if ctxErr := ctx.Err(); ctxErr != nil {
					return ctxErr
				}
				var entry wiktextractEntry
				if jsonErr := json.Unmarshal(line, &entry); jsonErr != nil {
					return fmt.Errorf("parse wiktextract line %d: %w", lineNumber, jsonErr)
				}
				if addErr := addWiktextractEntry(w, edition, &entry); addErr != nil {
					return addErr
				}
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
		}
	}
}

func wiktextractCandidate(line []byte) bool {
	for _, pattern := range wiktextractPatterns {
		if bytes.Contains(line, pattern) {
			return true
		}
	}
	return false
}

func addWiktextractEntry(w *writer, edition dictionary.Lang, entry *wiktextractEntry) error {
	from, ok := wiktextractLangCodes[entry.LangCode]
	if !ok {
		return nil
	}
	if strings.EqualFold(strings.TrimSpace(entry.POS), "romanization") {
		return nil
	}
	word := strings.TrimSpace(entry.Word)
	if word == "" {
		return nil
	}
	if from == dictionary.Chinese && w.simplifier.Len() == 0 {
		w.warnOnce("t2s", "zh_t2s is empty: Chinese headwords are stored without Traditional→Simplified conversion; import cc-cedict first and re-import this source")
	}
	toTarget := func(text string) string {
		if edition == dictionary.Chinese {
			return w.simplifier.Simplify(text)
		}
		return text
	}
	toSource := func(text string) string {
		if from == dictionary.Chinese {
			return w.simplifier.Simplify(text)
		}
		return text
	}

	var definitions []string
	formOnly := true
	for _, sense := range entry.Senses {
		var parts []string
		for _, gloss := range sense.Glosses {
			if gloss = strings.TrimSpace(gloss); gloss != "" {
				parts = append(parts, toTarget(gloss))
			}
		}
		if len(parts) == 0 {
			continue
		}
		definition := strings.Join(parts, ": ")
		if slices.Contains(definitions, definition) {
			continue
		}
		definitions = append(definitions, definition)
		if !slices.Contains(sense.Tags, "form-of") && !slices.Contains(sense.Tags, "alt-of") {
			formOnly = false
		}
	}
	if len(definitions) == 0 {
		return nil
	}

	headword := toSource(word)
	keys := []key{{headword, dictionary.KeyHeadword}}
	if headword != word {
		keys = append(keys, key{word, dictionary.KeyVariant})
	}
	reading := ""
	for _, form := range entry.Forms {
		text := strings.TrimSpace(form.Form)
		if text == "" || text == "-" || slices.ContainsFunc(form.Tags, func(tag string) bool {
			return slices.Contains(wiktextractSkippedFormTags, tag)
		}) {
			continue
		}
		if from == dictionary.Japanese && (slices.Contains(form.Tags, "hiragana") || slices.Contains(form.Tags, "kana")) {
			if reading == "" {
				reading = text
			}
			keys = append(keys, key{text, dictionary.KeyReading})
			continue
		}
		keys = append(keys, key{toSource(text), dictionary.KeyForm})
	}
	switch from {
	case dictionary.Chinese:
		reading = wiktextractPinyin(entry)
	case dictionary.Japanese:
		if reading == "" {
			for _, sound := range entry.Sounds {
				if isKana(sound.Other) {
					reading = sound.Other
					keys = append(keys, key{reading, dictionary.KeyReading})
					break
				}
			}
		}
	}
	if reading == headword {
		reading = ""
	}
	rank := 0
	if formOnly {
		rank = 1
	}
	return w.add(record{
		from:        from,
		to:          edition,
		headword:    headword,
		reading:     reading,
		pos:         entry.POS,
		definitions: definitions,
		rank:        rank,
		keys:        keys,
	})
}

func wiktextractPinyin(entry *wiktextractEntry) string {
	fallback := ""
	for _, sound := range entry.Sounds {
		if sound.ZhPron == "" {
			continue
		}
		for _, tag := range sound.Tags {
			lower := strings.ToLower(tag)
			if strings.Contains(lower, "pinyin") || strings.Contains(tag, "拼音") {
				return sound.ZhPron
			}
			if fallback == "" && (lower == "mandarin" || tag == "官話" || tag == "官话") {
				fallback = sound.ZhPron
			}
		}
	}
	if fallback != "" {
		return fallback
	}
	for _, sound := range entry.Sounds {
		if sound.Pinyin != "" {
			return sound.Pinyin
		}
	}
	return ""
}

func isKana(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if !(r >= 'ぁ' && r <= 'ゖ') && !(r >= 'ァ' && r <= 'ヺ') && r != 'ー' {
			return false
		}
	}
	return true
}
