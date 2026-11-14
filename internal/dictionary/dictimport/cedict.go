package dictimport

import (
	"bufio"
	"context"
	"database/sql"
	"fmt"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"pandalibrary/internal/dictionary"
)

// parseCEDICT reads CC-CEDICT lines "TRAD SIMP [pin1 yin1] /def1/def2/" into zh→en entries
// and rebuilds zh_t2s from every differing Traditional/Simplified pair.
func parseCEDICT(ctx context.Context, input io.Reader, w *writer) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	// Characters that are also valid Simplified characters on their own (e.g. 乾, 著) are
	// not mapped character by character; their conversion relies on whole-word pairs.
	selfSimplified := map[string]struct{}{}
	if err := w.resetT2S(); err != nil {
		return err
	}
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "\ufeff"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		trad, simp, pinyin, definitions, ok := parseCEDICTLine(line)
		if !ok {
			continue
		}
		if trad != simp {
			if err := w.addT2S(trad, simp); err != nil {
				return err
			}
		} else if utf8.RuneCountInString(trad) == 1 {
			selfSimplified[trad] = struct{}{}
		}
		keys := []key{{simp, dictionary.KeyHeadword}}
		if trad != simp {
			keys = append(keys, key{trad, dictionary.KeyVariant})
		}
		if err := w.add(record{
			from:        dictionary.Chinese,
			to:          dictionary.English,
			headword:    simp,
			reading:     pinyin,
			definitions: definitions,
			rank:        cedictRank(pinyin, definitions),
			keys:        keys,
		}); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read CC-CEDICT: %w", err)
	}
	w.beforeFinish = append(w.beforeFinish, func(tx *sql.Tx) error {
		statement, err := tx.PrepareContext(w.ctx, `DELETE FROM zh_t2s WHERE trad = ?`)
		if err != nil {
			return err
		}
		defer statement.Close()
		for character := range selfSimplified {
			if _, err := statement.ExecContext(w.ctx, character); err != nil {
				return fmt.Errorf("prune Chinese variants: %w", err)
			}
		}
		return nil
	})
	return nil
}

func parseCEDICTLine(line string) (trad, simp, pinyin string, definitions []string, ok bool) {
	open := strings.Index(line, " [")
	closing := strings.Index(line, "] /")
	if open < 0 || closing < open {
		return "", "", "", nil, false
	}
	words := strings.Fields(line[:open])
	if len(words) != 2 {
		return "", "", "", nil, false
	}
	trad, simp = words[0], words[1]
	pinyin = strings.TrimSpace(line[open+2 : closing])
	for definition := range strings.SplitSeq(line[closing+3:], "/") {
		if definition = strings.TrimSpace(definition); definition != "" {
			definitions = append(definitions, definition)
		}
	}
	return trad, simp, pinyin, definitions, len(definitions) > 0
}

// cedictRank puts proper nouns, surnames and variant references after ordinary words.
func cedictRank(pinyin string, definitions []string) int {
	rank := 0
	if first, _ := utf8.DecodeRuneInString(pinyin); unicode.IsUpper(first) {
		rank++
	}
	lead := strings.ToLower(definitions[0])
	for _, prefix := range []string{"variant of", "old variant of", "erhua variant of", "see ", "surname "} {
		if strings.HasPrefix(lead, prefix) {
			rank += 2
			break
		}
	}
	return rank
}
