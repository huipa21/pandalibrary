package catalog

import (
	"strings"

	"github.com/mozillazg/go-pinyin"
)

// SortTitle produces the deterministic article-folded, toneless-pinyin catalog sort key.
func SortTitle(title string) string {
	value := strings.ToLower(strings.TrimSpace(title))
	article := ""
	for _, prefix := range []string{"the ", "an ", "a "} {
		if strings.HasPrefix(value, prefix) && strings.TrimSpace(value[len(prefix):]) != "" {
			value = strings.TrimSpace(value[len(prefix):])
			article = strings.TrimSpace(prefix)
			break
		}
	}
	options := pinyin.NewArgs()
	options.Fallback = func(r rune, _ pinyin.Args) []string { return []string{string(r)} }
	value = strings.Join(pinyin.LazyPinyin(value, options), "")
	if article != "" {
		value += ", " + article
	}
	return value
}
