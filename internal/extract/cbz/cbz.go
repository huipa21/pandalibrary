package cbz

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "golang.org/x/image/webp"

	"pandalibrary/internal/extract"
)

const comicInfoFilename = "ComicInfo.xml"

type comicPage struct {
	Image int
	Type  string
}

func Register(registry *extract.Registry) error {
	return registry.Register(extract.FormatCBZ, Extract)
}

func Extract(ctx context.Context, input io.ReaderAt, size int64, filename string) (extract.Metadata, error) {
	if ctx == nil {
		return extract.Metadata{}, fmt.Errorf("%w: context is required", extract.ErrInvalidInput)
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	archive, err := extract.OpenArchive(input, size)
	if err != nil {
		return extract.Metadata{}, err
	}

	result := extract.Metadata{}
	infoName, err := findComicInfo(archive)
	if err != nil {
		return extract.Metadata{}, err
	}
	var info comicInfo
	if infoName != "" {
		data, err := archive.ReadFile(infoName, extract.MaxMetadataDocumentSize)
		if err != nil {
			return extract.Metadata{}, fmt.Errorf("read CBZ ComicInfo.xml: %w", err)
		}
		info, err = parseComicInfo(ctx, data)
		if err != nil {
			if contextErr := ctx.Err(); contextErr != nil {
				return extract.Metadata{}, contextErr
			}
			return extract.Metadata{}, fmt.Errorf("%w: parse CBZ ComicInfo.xml: %v", extract.ErrInvalidInput, err)
		}
		if err := applyComicInfo(&result, info); err != nil {
			return extract.Metadata{}, err
		}
	}
	if strings.TrimSpace(result.Title) == "" {
		result.Title = cleanFilename(filename)
	}

	images := archiveImageNames(archive)
	if len(images) > 0 {
		sort.Slice(images, func(i, j int) bool {
			return naturalLess(images[i], images[j])
		})
		coverIndex := frontCoverImageIndex(info.Pages)
		if coverIndex < 0 || coverIndex >= len(images) {
			coverIndex = 0
		}
		cover, err := archive.ReadFile(images[coverIndex], extract.MaxCoverEntrySize)
		if err != nil {
			return extract.Metadata{}, fmt.Errorf("read CBZ cover %q: %w", images[coverIndex], err)
		}
		if err := validateCover(cover); err != nil {
			return extract.Metadata{}, fmt.Errorf("CBZ cover %q: %w", images[coverIndex], err)
		}
		result.Cover = cover
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	return result, nil
}

type comicInfo struct {
	Values map[string]string
	Genres []string
	Tags   []string
	Pages  []comicPage
}

func findComicInfo(archive *extract.Archive) (string, error) {
	found := ""
	for _, name := range archive.Names() {
		if !strings.EqualFold(name, comicInfoFilename) {
			continue
		}
		if found != "" {
			return "", fmt.Errorf("%w: multiple ComicInfo.xml entries", extract.ErrInvalidInput)
		}
		found = name
	}
	return found, nil
}

func parseComicInfo(ctx context.Context, data []byte) (comicInfo, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	info := comicInfo{Values: make(map[string]string)}
	var stack []string
	var field string
	var fieldText strings.Builder
	rootSeen := false
	pagesDepth := 0

	for {
		if err := ctx.Err(); err != nil {
			return comicInfo{}, err
		}
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return comicInfo{}, err
		}
		switch token := token.(type) {
		case xml.StartElement:
			name := token.Name.Local
			if len(stack) == 0 {
				if rootSeen || !strings.EqualFold(name, "ComicInfo") {
					return comicInfo{}, fmt.Errorf("unexpected XML root %q", name)
				}
				rootSeen = true
			} else if field != "" {
				return comicInfo{}, fmt.Errorf("ComicInfo field %q contains nested elements", field)
			} else if len(stack) == 1 {
				switch name {
				case "Pages":
					pagesDepth = len(stack) + 1
				case "Genre", "Tags":
					field = name
					fieldText.Reset()
				case "Title", "Series", "Number", "Writer", "Summary", "Year", "Month", "Day",
					"Publisher", "LanguageISO", "PageCount":
					if _, exists := info.Values[name]; exists {
						return comicInfo{}, fmt.Errorf("duplicate ComicInfo field %q", name)
					}
					field = name
					fieldText.Reset()
				}
			} else if pagesDepth > 0 && len(stack) == pagesDepth && name == "Page" {
				page := comicPage{Image: -1}
				for _, attr := range token.Attr {
					switch attr.Name.Local {
					case "Image":
						if attr.Value != "" {
							page.Image, err = strconv.Atoi(strings.TrimSpace(attr.Value))
							if err != nil {
								return comicInfo{}, fmt.Errorf("invalid ComicInfo page image index %q", attr.Value)
							}
						}
					case "Type":
						page.Type = strings.TrimSpace(attr.Value)
					}
				}
				info.Pages = append(info.Pages, page)
			}
			stack = append(stack, name)
		case xml.EndElement:
			if len(stack) == 0 || stack[len(stack)-1] != token.Name.Local {
				return comicInfo{}, fmt.Errorf("unexpected XML end element %q", token.Name.Local)
			}
			if field != "" && len(stack) == 2 {
				value := strings.TrimSpace(fieldText.String())
				switch field {
				case "Genre":
					info.Genres = append(info.Genres, value)
				case "Tags":
					info.Tags = append(info.Tags, value)
				default:
					info.Values[field] = value
				}
				field = ""
				fieldText.Reset()
			}
			if len(stack) == pagesDepth {
				pagesDepth = 0
			}
			stack = stack[:len(stack)-1]
		case xml.CharData:
			if field != "" && len(stack) == 2 {
				_, _ = fieldText.Write(token)
			} else if len(stack) == 0 && strings.TrimSpace(string(token)) != "" {
				return comicInfo{}, fmt.Errorf("character data outside the ComicInfo root")
			}
		case xml.Directive:
			return comicInfo{}, fmt.Errorf("XML directives are not accepted")
		}
	}
	if !rootSeen || len(stack) != 0 || field != "" {
		return comicInfo{}, fmt.Errorf("incomplete ComicInfo.xml document")
	}
	return info, nil
}

func applyComicInfo(result *extract.Metadata, info comicInfo) error {
	result.Title = strings.TrimSpace(info.Values["Title"])
	if value := strings.TrimSpace(info.Values["Series"]); value != "" {
		result.Series = stringPointer(value)
	}
	if value := strings.TrimSpace(info.Values["Number"]); value != "" {
		index, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(index) || math.IsInf(index, 0) || index < 0 {
			return fmt.Errorf("%w: invalid CBZ series number %q", extract.ErrInvalidInput, value)
		}
		result.SeriesIndex = &index
	}
	if value := strings.TrimSpace(info.Values["Writer"]); value != "" {
		result.Authors = []extract.Author{{Name: value, Role: "writer"}}
	}
	if value := strings.TrimSpace(info.Values["Summary"]); value != "" {
		result.Description = stringPointer(value)
	}
	if value := strings.TrimSpace(info.Values["Publisher"]); value != "" {
		result.Publisher = stringPointer(value)
	}
	if value := strings.TrimSpace(info.Values["LanguageISO"]); value != "" {
		result.Language = stringPointer(value)
	}
	result.Tags = appendTags(result.Tags, info.Genres...)
	result.Tags = appendTags(result.Tags, info.Tags...)

	date, err := comicDate(info.Values)
	if err != nil {
		return err
	}
	result.Date = date
	if value := strings.TrimSpace(info.Values["PageCount"]); value != "" {
		pageCount, err := strconv.Atoi(value)
		if err != nil || pageCount < 0 {
			return fmt.Errorf("%w: invalid CBZ page count %q", extract.ErrInvalidInput, value)
		}
		result.PageCount = &pageCount
	}
	return nil
}

func comicDate(values map[string]string) (*string, error) {
	year, err := optionalInteger(values, "Year")
	if err != nil {
		return nil, err
	}
	month, err := optionalInteger(values, "Month")
	if err != nil {
		return nil, err
	}
	day, err := optionalInteger(values, "Day")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(values["Year"]) != "" && year == 0 {
		return nil, fmt.Errorf("%w: invalid CBZ publication year", extract.ErrInvalidInput)
	}
	if year == 0 {
		if month != 0 || day != 0 {
			return nil, fmt.Errorf("%w: CBZ month/day requires a year", extract.ErrInvalidInput)
		}
		return nil, nil
	}
	if year < 1 || year > 9999 || month < 0 || month > 12 || day < 0 || day > 31 {
		return nil, fmt.Errorf("%w: invalid CBZ publication date", extract.ErrInvalidInput)
	}
	value := fmt.Sprintf("%04d", year)
	if month > 0 {
		value += fmt.Sprintf("-%02d", month)
	}
	if day > 0 {
		if month == 0 {
			return nil, fmt.Errorf("%w: CBZ day requires a month", extract.ErrInvalidInput)
		}
		date := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
		if date.Year() != year || int(date.Month()) != month || date.Day() != day {
			return nil, fmt.Errorf("%w: invalid CBZ publication date", extract.ErrInvalidInput)
		}
		value += fmt.Sprintf("-%02d", day)
	}
	return &value, nil
}

func optionalInteger(values map[string]string, key string) (int, error) {
	value := strings.TrimSpace(values[key])
	if value == "" {
		return 0, nil
	}
	number, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%w: invalid CBZ %s %q", extract.ErrInvalidInput, key, value)
	}
	return number, nil
}

func archiveImageNames(archive *extract.Archive) []string {
	var names []string
	for _, name := range archive.Names() {
		switch strings.ToLower(path.Ext(name)) {
		case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff":
			names = append(names, name)
		}
	}
	return names
}

func frontCoverImageIndex(pages []comicPage) int {
	for _, page := range pages {
		if strings.EqualFold(page.Type, "FrontCover") {
			return page.Image
		}
	}
	return -1
}

func validateCover(data []byte) error {
	if len(data) == 0 || len(data) > extract.MaxCoverEntrySize {
		return fmt.Errorf("%w: cover size is %d bytes", extract.ErrTooLarge, len(data))
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("%w: invalid cover image: %v", extract.ErrInvalidInput, err)
	}
	if format != "jpeg" && format != "png" && format != "gif" && format != "webp" {
		return fmt.Errorf("%w: unsupported cover image format %q", extract.ErrUnsupportedFormat, format)
	}
	if config.Width <= 0 || config.Height <= 0 {
		return fmt.Errorf("%w: invalid cover dimensions", extract.ErrInvalidInput)
	}
	if int64(config.Width) > 20_000_000/int64(config.Height) {
		return fmt.Errorf("%w: cover dimensions are too large", extract.ErrTooLarge)
	}
	return nil
}

func appendTags(tags []string, values ...string) []string {
	seen := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		seen[tag] = struct{}{}
	}
	for _, value := range values {
		for _, tag := range strings.FieldsFunc(value, func(r rune) bool {
			return r == ',' || r == ';' || r == '|'
		}) {
			tag = strings.TrimSpace(tag)
			if tag == "" {
				continue
			}
			if _, exists := seen[tag]; exists {
				continue
			}
			seen[tag] = struct{}{}
			tags = append(tags, tag)
		}
	}
	return tags
}

func cleanFilename(filename string) string {
	name := strings.TrimSuffix(path.Base(strings.ReplaceAll(filename, `\`, "/")), path.Ext(filename))
	name = strings.NewReplacer("_", " ", ".", " ").Replace(name)
	return strings.Join(strings.Fields(name), " ")
}

func naturalLess(left, right string) bool {
	a, b := []byte(strings.ToLower(left)), []byte(strings.ToLower(right))
	for i, j := 0, 0; i < len(a) && j < len(b); {
		if isDigit(a[i]) && isDigit(b[j]) {
			aEnd, bEnd := i, j
			for aEnd < len(a) && isDigit(a[aEnd]) {
				aEnd++
			}
			for bEnd < len(b) && isDigit(b[bEnd]) {
				bEnd++
			}
			aSignificant, bSignificant := i, j
			for aSignificant < aEnd && a[aSignificant] == '0' {
				aSignificant++
			}
			for bSignificant < bEnd && b[bSignificant] == '0' {
				bSignificant++
			}
			aLength, bLength := aEnd-aSignificant, bEnd-bSignificant
			if aLength != bLength {
				return aLength < bLength
			}
			if comparison := bytes.Compare(a[aSignificant:aEnd], b[bSignificant:bEnd]); comparison != 0 {
				return comparison < 0
			}
			if aEnd-i != bEnd-j {
				return aEnd-i < bEnd-j
			}
			i, j = aEnd, bEnd
			continue
		}
		if a[i] != b[j] {
			return a[i] < b[j]
		}
		i++
		j++
	}
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return left < right
}

func isDigit(value byte) bool {
	return value >= '0' && value <= '9'
}

func stringPointer(value string) *string {
	return &value
}
