package catalog

import (
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

const maximumAssociations = 1000

func normalizeBookPatch(patch BookPatch) (BookPatch, []string, error) {
	fields := make([]string, 0, 11)
	if patch.LibraryID.Set && (patch.LibraryID.Value == nil || *patch.LibraryID.Value < 1) {
		return BookPatch{}, nil, invalid("library ID must be positive")
	}
	if patch.Title.Set {
		if patch.Title.Value == nil {
			return BookPatch{}, nil, invalid("title cannot be null")
		}
		title, err := validateName(*patch.Title.Value, "title")
		if err != nil {
			return BookPatch{}, nil, err
		}
		patch.Title.Value = &title
		fields = append(fields, "title")
	}
	for _, field := range []struct {
		name  string
		value *Optional[string]
		limit int
		trim  bool
	}{
		{"subtitle", &patch.Subtitle, 4096, true},
		{"description", &patch.Description, 1 << 20, false},
		{"language", &patch.Language, 255, true},
		{"publisher", &patch.Publisher, 4096, true},
		{"published_date", &patch.PublishedDate, 10, true},
	} {
		if !field.value.Set {
			continue
		}
		if field.value.Value != nil {
			value := *field.value.Value
			if field.trim {
				value = strings.TrimSpace(value)
			}
			if len(value) > field.limit || !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
				return BookPatch{}, nil, invalid(field.name + " is invalid or too long")
			}
			if field.name == "published_date" && !validPublishedDate(value) {
				return BookPatch{}, nil, invalid("published date must be a valid YYYY, YYYY-MM, or YYYY-MM-DD date")
			}
			field.value.Value = &value
		}
		fields = append(fields, field.name)
	}
	if patch.PageCount.Set {
		if patch.PageCount.Value != nil && *patch.PageCount.Value < 1 {
			return BookPatch{}, nil, invalid("page count must be positive")
		}
		fields = append(fields, "page_count")
	}
	if patch.Series.Set {
		if patch.Series.Value != nil {
			value := *patch.Series.Value
			name, err := validateName(value.Name, "series name")
			if err != nil {
				return BookPatch{}, nil, err
			}
			if value.Index != nil && (*value.Index < 0 || math.IsNaN(*value.Index) || math.IsInf(*value.Index, 0)) {
				return BookPatch{}, nil, invalid("series index must be finite and nonnegative")
			}
			value.Name = name
			patch.Series.Value = &value
		}
		fields = append(fields, "series")
	}
	if patch.Authors.Set {
		if patch.Authors.Value == nil || len(*patch.Authors.Value) > maximumAssociations {
			return BookPatch{}, nil, invalid("authors must be an array of at most 1000 entries")
		}
		values := append([]AuthorInput(nil), (*patch.Authors.Value)...)
		seen := make(map[string]struct{}, len(values))
		for i := range values {
			name, err := validateName(values[i].Name, "author name")
			if err != nil {
				return BookPatch{}, nil, err
			}
			switch values[i].Role {
			case "author", "translator", "editor", "illustrator":
			default:
				return BookPatch{}, nil, invalid("author role is invalid")
			}
			key := sqliteFold(name) + "\x00" + values[i].Role
			if _, exists := seen[key]; exists {
				return BookPatch{}, nil, invalid("duplicate author and role")
			}
			seen[key] = struct{}{}
			values[i].Name = name
		}
		patch.Authors.Value = &values
		fields = append(fields, "authors")
	}
	if patch.Tags.Set {
		if patch.Tags.Value == nil || len(*patch.Tags.Value) > maximumAssociations {
			return BookPatch{}, nil, invalid("tags must be an array of at most 1000 entries")
		}
		values := append([]string(nil), (*patch.Tags.Value)...)
		seen := make(map[string]struct{}, len(values))
		for i := range values {
			name, err := validateName(values[i], "tag name")
			if err != nil {
				return BookPatch{}, nil, err
			}
			key := sqliteFold(name)
			if _, exists := seen[key]; exists {
				return BookPatch{}, nil, invalid("duplicate tag")
			}
			seen[key] = struct{}{}
			values[i] = name
		}
		patch.Tags.Value = &values
		fields = append(fields, "tags")
	}
	if patch.Identifiers.Set {
		if patch.Identifiers.Value == nil || len(*patch.Identifiers.Value) > maximumAssociations {
			return BookPatch{}, nil, invalid("identifiers must be an array of at most 1000 entries")
		}
		values := append([]Identifier(nil), (*patch.Identifiers.Value)...)
		seen := make(map[string]struct{}, len(values))
		for i := range values {
			switch values[i].Scheme {
			case "isbn13", "isbn10", "asin", "doi", "uuid", "openlibrary", "googlebooks", "neodb", "hardcover", "douban":
			default:
				return BookPatch{}, nil, invalid("identifier scheme is invalid")
			}
			value := strings.TrimSpace(values[i].Value)
			if value == "" || len(value) > 2048 || !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
				return BookPatch{}, nil, invalid("identifier value is invalid")
			}
			key := values[i].Scheme + "\x00" + value
			if _, exists := seen[key]; exists {
				return BookPatch{}, nil, invalid("duplicate identifier")
			}
			seen[key] = struct{}{}
			values[i].Value = value
		}
		patch.Identifiers.Value = &values
		fields = append(fields, "identifiers")
	}
	if len(fields) == 0 && !patch.LibraryID.Set {
		return BookPatch{}, nil, invalid("at least one book update is required")
	}
	return patch, fields, nil
}

func validPublishedDate(value string) bool {
	layout := ""
	switch len(value) {
	case 4:
		layout = "2006"
	case 7:
		layout = "2006-01"
	case 10:
		layout = "2006-01-02"
	default:
		return false
	}
	parsed, err := time.Parse(layout, value)
	return err == nil && parsed.Format(layout) == value
}

func sqliteFold(value string) string {
	bytes := []byte(value)
	for i, b := range bytes {
		if b >= 'A' && b <= 'Z' {
			bytes[i] = b + ('a' - 'A')
		}
	}
	return string(bytes)
}
