package dictimport

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"pandalibrary/internal/dictionary"
)

// ecdictUnranked orders entries without COCA/BNC frequency after ranked ones.
const ecdictUnranked = 1 << 30

// parseECDICT reads ecdict.csv (word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,...).
func parseECDICT(ctx context.Context, input io.Reader, w *writer) error {
	reader := csv.NewReader(input)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	reader.ReuseRecord = true
	header, err := reader.Read()
	if err != nil {
		return fmt.Errorf("read ECDICT header: %w", err)
	}
	columns := map[string]int{}
	for index, name := range header {
		columns[strings.ToLower(strings.TrimSpace(strings.TrimPrefix(name, "\ufeff")))] = index
	}
	for _, required := range []string{"word", "translation"} {
		if _, ok := columns[required]; !ok {
			return fmt.Errorf("ECDICT header has no %q column", required)
		}
	}
	field := func(row []string, name string) string {
		index, ok := columns[name]
		if !ok || index >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[index])
	}
	for {
		row, err := reader.Read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read ECDICT: %w", err)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		word := field(row, "word")
		definitions := splitECDICTText(field(row, "translation"))
		if word == "" || len(definitions) == 0 {
			continue
		}
		keys := []key{{word, dictionary.KeyHeadword}}
		for _, item := range strings.Split(field(row, "exchange"), "/") {
			kind, form, ok := strings.Cut(item, ":")
			if !ok || form == "" {
				continue
			}
			switch kind {
			case "p", "d", "i", "3", "r", "t", "s":
				keys = append(keys, key{form, dictionary.KeyForm})
			}
		}
		if err := w.add(record{
			from:        dictionary.English,
			to:          dictionary.Chinese,
			headword:    word,
			reading:     field(row, "phonetic"),
			definitions: definitions,
			rank:        ecdictRank(field(row, "frq"), field(row, "bnc")),
			keys:        keys,
		}); err != nil {
			return err
		}
	}
}

// splitECDICTText splits on the literal "\n" separators ECDICT uses inside fields.
func splitECDICTText(value string) []string {
	value = strings.ReplaceAll(value, `\r`, "")
	value = strings.ReplaceAll(value, `\n`, "\n")
	var lines []string
	for line := range strings.SplitSeq(value, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func ecdictRank(values ...string) int {
	for _, value := range values {
		if rank, err := strconv.Atoi(value); err == nil && rank > 0 {
			return rank
		}
	}
	return ecdictUnranked
}
