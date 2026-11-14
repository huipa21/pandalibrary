package dictimport

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"pandalibrary/internal/dictionary"
)

type jmdictEntry struct {
	Kanji []struct {
		Text     string   `xml:"keb"`
		Priority []string `xml:"ke_pri"`
	} `xml:"k_ele"`
	Readings []struct {
		Text     string   `xml:"reb"`
		Priority []string `xml:"re_pri"`
	} `xml:"r_ele"`
	Senses []struct {
		POS     []string `xml:"pos"`
		Glosses []struct {
			Text string `xml:",chardata"`
			Lang string `xml:"http://www.w3.org/XML/1998/namespace lang,attr"`
			Type string `xml:"g_type,attr"`
		} `xml:"gloss"`
	} `xml:"sense"`
}

var (
	jmdictEntityPattern = regexp.MustCompile(`<!ENTITY\s+([^\s"]+)\s+"`)
	parenthesised       = regexp.MustCompile(`\([^()]*\)`)
)

// jmdictUnranked is the base rank of entries without news1/ichi1/spec1/gai1 priority.
const jmdictUnranked = 1000

// parseJMdict streams JMdict XML into ja→en entries and reverse en→ja entries built from short glosses.
// DTD entities such as &n; resolve to their own name ("n").
func parseJMdict(ctx context.Context, input io.Reader, w *writer) error {
	decoder := xml.NewDecoder(input)
	decoder.Strict = false
	decoder.Entity = map[string]string{}
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read JMdict: %w", err)
		}
		switch token := token.(type) {
		case xml.Directive:
			for _, match := range jmdictEntityPattern.FindAllSubmatch(token, -1) {
				name := string(match[1])
				decoder.Entity[name] = name
			}
		case xml.StartElement:
			if token.Name.Local != "entry" {
				continue
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			var entry jmdictEntry
			if err := decoder.DecodeElement(&entry, &token); err != nil {
				return fmt.Errorf("read JMdict entry: %w", err)
			}
			if err := addJMdictEntry(w, &entry); err != nil {
				return err
			}
		}
	}
}

func addJMdictEntry(w *writer, entry *jmdictEntry) error {
	if len(entry.Readings) == 0 {
		return nil
	}
	reading := strings.TrimSpace(entry.Readings[0].Text)
	headword := reading
	if len(entry.Kanji) > 0 {
		headword = strings.TrimSpace(entry.Kanji[0].Text)
	}
	rank := jmdictUnranked
	var keys []key
	for _, kanji := range entry.Kanji {
		keys = append(keys, key{kanji.Text, dictionary.KeyHeadword})
		rank = min(rank, jmdictRank(kanji.Priority))
	}
	for _, r := range entry.Readings {
		keys = append(keys, key{r.Text, dictionary.KeyReading})
		rank = min(rank, jmdictRank(r.Priority))
	}

	type sense struct {
		pos     string
		glosses []string
		short   []string
	}
	var senses []sense
	var allPOS []string
	seenPOS := map[string]bool{}
	previousPOS := ""
	for _, s := range entry.Senses {
		var current sense
		if len(s.POS) > 0 {
			previousPOS = strings.Join(s.POS, ", ")
			for _, pos := range s.POS {
				if !seenPOS[pos] {
					seenPOS[pos] = true
					allPOS = append(allPOS, pos)
				}
			}
		}
		current.pos = previousPOS
		for _, gloss := range s.Glosses {
			if gloss.Lang != "" && gloss.Lang != "eng" {
				continue
			}
			text := strings.TrimSpace(gloss.Text)
			if text == "" {
				continue
			}
			current.glosses = append(current.glosses, text)
			if gloss.Type != "expl" {
				if short := shortGloss(text); short != "" {
					current.short = append(current.short, short)
				}
			}
		}
		if len(current.glosses) > 0 {
			senses = append(senses, current)
		}
	}
	if len(senses) == 0 {
		return nil
	}
	definitions := make([]string, len(senses))
	for index, s := range senses {
		definitions[index] = strings.Join(s.glosses, "; ")
	}
	displayReading := reading
	if displayReading == headword {
		displayReading = ""
	}
	if err := w.add(record{
		from:        dictionary.Japanese,
		to:          dictionary.English,
		headword:    headword,
		reading:     displayReading,
		pos:         strings.Join(allPOS, ", "),
		definitions: definitions,
		rank:        rank,
		keys:        keys,
	}); err != nil {
		return err
	}

	translation := headword
	if displayReading != "" {
		translation = headword + "（" + reading + "）"
	}
	seen := map[string]bool{}
	for senseIndex, s := range senses {
		for glossIndex, gloss := range s.short {
			normalized := dictionary.NormalizeKey(dictionary.English, gloss)
			if normalized == "" || seen[normalized] {
				continue
			}
			seen[normalized] = true
			if err := w.add(record{
				from:        dictionary.English,
				to:          dictionary.Japanese,
				headword:    gloss,
				pos:         s.pos,
				definitions: []string{translation},
				rank:        rank*100 + min(senseIndex, 9)*10 + min(glossIndex, 9),
				keys:        []key{{gloss, dictionary.KeyHeadword}},
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

// shortGloss returns gloss without parenthesised notes and a leading "to " when it has at most four words.
func shortGloss(gloss string) string {
	for {
		stripped := parenthesised.ReplaceAllString(gloss, " ")
		if stripped == gloss {
			break
		}
		gloss = stripped
	}
	if strings.ContainsAny(gloss, "()") {
		return ""
	}
	words := strings.Fields(gloss)
	if len(words) > 0 && strings.EqualFold(words[0], "to") {
		words = words[1:]
	}
	if len(words) == 0 || len(words) > 4 {
		return ""
	}
	return strings.Join(words, " ")
}

func jmdictRank(priorities []string) int {
	common := false
	frequency := 0
	for _, priority := range priorities {
		switch priority {
		case "news1", "ichi1", "spec1", "gai1":
			common = true
		default:
			if band, ok := strings.CutPrefix(priority, "nf"); ok {
				if value, err := strconv.Atoi(band); err == nil {
					frequency = value
				}
			}
		}
	}
	if !common {
		return jmdictUnranked
	}
	if frequency > 0 {
		return frequency
	}
	return 50
}
