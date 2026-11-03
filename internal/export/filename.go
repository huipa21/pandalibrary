package export

import (
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

func markdownFilename(title string, authors []string) string {
	author := "Unknown Author"
	if len(authors) > 0 && strings.TrimSpace(authors[0]) != "" {
		author = authors[0]
	}
	return safeMarkdownFilename(oneLine(title) + " - " + oneLine(author))
}

func uniqueMarkdownFilenames(books []book) []string {
	result := make([]string, len(books))
	used := make(map[string]struct{}, len(books))
	for index, item := range books {
		base := markdownFilename(item.title, item.authors)
		name := base
		for suffix := 2; ; suffix++ {
			key := filenameCollisionKey(name)
			if _, exists := used[key]; !exists {
				used[key] = struct{}{}
				result[index] = name
				break
			}
			suffixText := fmt.Sprintf(" (%d)", suffix)
			stem := strings.TrimSuffix(base, ".md")
			name = safeMarkdownFilename(truncateRunes(stem, 150-len([]rune(suffixText))) + suffixText)
		}
	}
	return result
}

func safeMarkdownFilename(name string) string {
	var safe strings.Builder
	for _, char := range name {
		switch {
		case unicode.IsControl(char), strings.ContainsRune(`<>:"/\|?*`, char):
			safe.WriteRune('_')
		default:
			safe.WriteRune(char)
		}
	}
	base := strings.TrimRight(strings.TrimSpace(safe.String()), ". ")
	if base == "" || base == "." || base == ".." {
		base = "Untitled"
	}
	if isWindowsDeviceName(base) {
		base = "_" + base
	}
	base = truncateRunes(base, 150)
	return base + ".md"
}

func isWindowsDeviceName(name string) bool {
	device := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	switch device {
	case "CON", "PRN", "AUX", "NUL":
		return true
	}
	if len(device) == 4 && (strings.HasPrefix(device, "COM") || strings.HasPrefix(device, "LPT")) &&
		device[3] >= '1' && device[3] <= '9' {
		return true
	}
	return false
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func filenameCollisionKey(value string) string {
	return strings.ToLower(norm.NFC.String(value))
}
