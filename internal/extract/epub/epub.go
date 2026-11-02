package epub

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"net/url"
	"path"
	"strconv"
	"strings"

	"pandalibrary/internal/extract"
)

const (
	epubMimetype = "application/epub+zip"
)

type node struct {
	Name     xml.Name
	Attrs    []xml.Attr
	Text     strings.Builder
	Children []*node
}

func Register(registry *extract.Registry) error {
	return registry.Register(extract.FormatEPUB, Extract)
}

func Extract(ctx context.Context, input io.ReaderAt, size int64, filename string) (extract.Metadata, error) {
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	archive, err := extract.OpenArchive(input, size)
	if err != nil {
		return extract.Metadata{}, err
	}
	mimetype, err := archive.ReadFile("mimetype", 256)
	if err != nil {
		return extract.Metadata{}, err
	}
	if string(mimetype) != epubMimetype {
		return extract.Metadata{}, fmt.Errorf("%w: EPUB mimetype entry is invalid", extract.ErrInvalidInput)
	}

	containerData, err := archive.ReadFile("META-INF/container.xml", extract.MaxMetadataDocumentSize)
	if err != nil {
		return extract.Metadata{}, fmt.Errorf("read EPUB container: %w", err)
	}
	container, err := parseXML(containerData)
	if err != nil {
		return extract.Metadata{}, fmt.Errorf("%w: parse EPUB container: %v", extract.ErrInvalidInput, err)
	}
	if container.Name.Local != "container" {
		return extract.Metadata{}, fmt.Errorf("%w: invalid EPUB container root", extract.ErrInvalidInput)
	}
	opfPath, err := findPackagePath(container)
	if err != nil {
		return extract.Metadata{}, err
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}

	opfData, err := archive.ReadFile(opfPath, extract.MaxMetadataDocumentSize)
	if err != nil {
		return extract.Metadata{}, fmt.Errorf("read EPUB package document: %w", err)
	}
	pkg, err := parseXML(opfData)
	if err != nil {
		return extract.Metadata{}, fmt.Errorf("%w: parse EPUB package document: %v", extract.ErrInvalidInput, err)
	}
	if pkg.Name.Local != "package" {
		return extract.Metadata{}, fmt.Errorf("%w: invalid EPUB package root", extract.ErrInvalidInput)
	}
	metadataNode := child(pkg, "metadata")
	if metadataNode == nil {
		return extract.Metadata{}, fmt.Errorf("%w: EPUB package has no metadata element", extract.ErrInvalidInput)
	}

	result := extract.Metadata{}
	setMetadata(&result, metadataNode)
	if strings.TrimSpace(result.Title) == "" {
		result.Title = cleanFilename(filename)
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	result.Cover, err = extractCover(archive, pkg, metadataNode, opfPath)
	if err != nil {
		return extract.Metadata{}, err
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	return result, nil
}

func findPackagePath(container *node) (string, error) {
	for _, rootfile := range descendants(container, "rootfile") {
		if !strings.EqualFold(attribute(rootfile, "media-type"), "application/oebps-package+xml") {
			continue
		}
		fullPath := attribute(rootfile, "full-path")
		clean, err := safePath(fullPath)
		if err != nil {
			return "", fmt.Errorf("%w: invalid EPUB package path: %v", extract.ErrInvalidInput, err)
		}
		if clean != "" {
			return clean, nil
		}
	}
	return "", fmt.Errorf("%w: EPUB container has no package document", extract.ErrInvalidInput)
}

func setMetadata(result *extract.Metadata, metadata *node) {
	var titles []*node
	creators := make([]*node, 0)
	for _, item := range metadata.Children {
		switch item.Name.Local {
		case "title":
			titles = append(titles, item)
		case "creator":
			creators = append(creators, item)
		case "language":
			result.Language = optionalText(item)
		case "publisher":
			result.Publisher = optionalText(item)
		case "date":
			result.Date = optionalText(item)
		case "description":
			result.Description = optionalText(item)
		case "subject":
			if tag := text(item); tag != "" {
				result.Tags = append(result.Tags, tag)
			}
		case "identifier":
			if identifier := parseIdentifier(item); identifier != nil {
				result.Identifiers = append(result.Identifiers, *identifier)
			}
		case "meta":
			property := strings.ToLower(attribute(item, "property"))
			name := strings.ToLower(attribute(item, "name"))
			if property == "page-count" || property == "schema:pagecount" ||
				name == "page-count" || name == "pagecount" {
				setPageCount(result, firstNonEmpty(attribute(item, "content"), text(item)))
			}
		}
	}

	refinements, legacy := readRefinements(metadata)
	for _, title := range titles {
		value := text(title)
		if value == "" {
			continue
		}
		titleType := refinements[attribute(title, "id")]["title-type"]
		if titleType == "subtitle" && result.Subtitle == nil {
			result.Subtitle = stringPointer(value)
		} else if result.Title == "" {
			result.Title = value
		} else if result.Subtitle == nil {
			result.Subtitle = stringPointer(value)
		}
	}

	for _, creator := range creators {
		name := text(creator)
		if name == "" {
			continue
		}
		id := attribute(creator, "id")
		role := firstNonEmpty(
			attribute(creator, "role"),
			refinements[id]["role"],
			legacy["role:"+id],
			"author",
		)
		fileAs := firstNonEmpty(
			attribute(creator, "file-as"),
			refinements[id]["file-as"],
			legacy["file-as:"+id],
		)
		result.Authors = append(result.Authors, extract.Author{
			Name: name, Role: normalizeRole(role), FileAs: fileAs,
		})
	}

	for _, item := range metadata.Children {
		if item.Name.Local != "meta" {
			continue
		}
		name := strings.ToLower(attribute(item, "name"))
		content := strings.TrimSpace(attribute(item, "content"))
		if content == "" {
			content = text(item)
		}
		switch name {
		case "calibre:series":
			if content != "" {
				result.Series = stringPointer(content)
			}
		case "calibre:series_index":
			setSeriesIndex(result, content)
		}
	}

	for _, item := range metadata.Children {
		if item.Name.Local != "meta" || attribute(item, "property") != "belongs-to-collection" {
			continue
		}
		id := attribute(item, "id")
		collectionType := strings.ToLower(refinements[id]["collection-type"])
		if collectionType != "" && collectionType != "series" {
			continue
		}
		if value := text(item); value != "" && result.Series == nil {
			result.Series = stringPointer(value)
			setSeriesIndex(result, refinements[id]["group-position"])
		}
	}
}

func readRefinements(metadata *node) (map[string]map[string]string, map[string]string) {
	refinements := make(map[string]map[string]string)
	legacy := make(map[string]string)
	for _, item := range metadata.Children {
		if item.Name.Local != "meta" {
			continue
		}
		refines := strings.TrimPrefix(attribute(item, "refines"), "#")
		property := strings.ToLower(attribute(item, "property"))
		if refines != "" && property != "" {
			if refinements[refines] == nil {
				refinements[refines] = make(map[string]string)
			}
			value := firstNonEmpty(attribute(item, "content"), text(item))
			refinements[refines][property] = value
		}

		name := strings.ToLower(attribute(item, "name"))
		content := strings.TrimSpace(attribute(item, "content"))
		switch name {
		case "role", "file-as":
			if refines != "" && content != "" {
				legacy[name+":"+refines] = content
			}
		}
	}
	return refinements, legacy
}

func parseIdentifier(item *node) *extract.Identifier {
	value := text(item)
	if value == "" {
		return nil
	}
	if isbn, scheme := normalizeISBN(value); scheme != "" {
		return &extract.Identifier{Scheme: scheme, Value: isbn}
	}
	scheme := strings.ToLower(strings.TrimSpace(attribute(item, "scheme")))
	if scheme == "" {
		scheme = "identifier"
	}
	return &extract.Identifier{Scheme: scheme, Value: value}
}

func normalizeISBN(value string) (string, string) {
	value = strings.TrimSpace(strings.TrimPrefix(strings.ToLower(value), "urn:isbn:"))
	var digits strings.Builder
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
			digits.WriteRune(r)
		case r == 'x' || r == 'X':
			digits.WriteByte('X')
		case r == '-' || r == ' ':
		default:
			return "", ""
		}
	}
	isbn := digits.String()
	if len(isbn) == 10 && validISBN10(isbn) {
		return isbn, "isbn10"
	}
	if len(isbn) == 13 && validISBN13(isbn) {
		return isbn, "isbn13"
	}
	return "", ""
}

func validISBN10(value string) bool {
	sum := 0
	for i := 0; i < 10; i++ {
		digit := 0
		if value[i] == 'X' && i == 9 {
			digit = 10
		} else if value[i] >= '0' && value[i] <= '9' {
			digit = int(value[i] - '0')
		} else {
			return false
		}
		sum += digit * (10 - i)
	}
	return sum%11 == 0
}

func validISBN13(value string) bool {
	sum := 0
	for i := 0; i < 13; i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
		digit := int(value[i] - '0')
		if i%2 == 1 {
			digit *= 3
		}
		sum += digit
	}
	return sum%10 == 0
}

func extractCover(archive *extract.Archive, pkg, metadata *node, opfPath string) ([]byte, error) {
	manifest := child(pkg, "manifest")
	items := make(map[string]*node)
	var coverItem *node
	for _, item := range children(manifest, "item") {
		id := attribute(item, "id")
		if id != "" {
			items[id] = item
		}
		for _, property := range strings.Fields(attribute(item, "properties")) {
			if property == "cover-image" && coverItem == nil {
				coverItem = item
			}
		}
	}
	if coverItem != nil {
		return readCoverItem(archive, coverItem, opfPath)
	}

	for _, item := range metadata.Children {
		if item.Name.Local == "meta" && strings.EqualFold(attribute(item, "name"), "cover") {
			if cover := items[strings.TrimSpace(attribute(item, "content"))]; cover != nil {
				return readCoverItem(archive, cover, opfPath)
			}
		}
	}

	guide := child(pkg, "guide")
	for _, reference := range children(guide, "reference") {
		if strings.EqualFold(attribute(reference, "type"), "cover") {
			return readGuideCover(archive, attribute(reference, "href"), opfPath)
		}
	}
	return nil, nil
}

func readCoverItem(archive *extract.Archive, item *node, opfPath string) ([]byte, error) {
	return readCoverHref(archive, attribute(item, "href"), opfPath)
}

func readCoverHref(archive *extract.Archive, href, opfPath string) ([]byte, error) {
	if href == "" {
		return nil, fmt.Errorf("%w: cover reference has no href", extract.ErrInvalidInput)
	}
	reference, err := url.Parse(href)
	if err != nil || reference.IsAbs() || reference.Host != "" {
		return nil, fmt.Errorf("%w: invalid EPUB cover reference %q", extract.ErrInvalidInput, href)
	}
	decodedPath, err := url.PathUnescape(reference.EscapedPath())
	if err != nil {
		return nil, fmt.Errorf("%w: invalid EPUB cover path %q", extract.ErrInvalidInput, href)
	}
	if strings.HasPrefix(decodedPath, "/") {
		return nil, fmt.Errorf("%w: absolute EPUB cover path %q", extract.ErrInvalidInput, href)
	}
	resource, err := safePath(path.Join(path.Dir(opfPath), decodedPath))
	if err != nil {
		return nil, fmt.Errorf("%w: unsafe EPUB cover path: %v", extract.ErrInvalidInput, err)
	}
	data, err := archive.ReadFile(resource, extract.MaxCoverEntrySize)
	if err != nil {
		return nil, fmt.Errorf("read EPUB cover: %w", err)
	}
	return data, nil
}

func readGuideCover(archive *extract.Archive, href, opfPath string) ([]byte, error) {
	if strings.EqualFold(path.Ext(strings.SplitN(href, "#", 2)[0]), ".jpg") ||
		strings.EqualFold(path.Ext(strings.SplitN(href, "#", 2)[0]), ".jpeg") ||
		strings.EqualFold(path.Ext(strings.SplitN(href, "#", 2)[0]), ".png") ||
		strings.EqualFold(path.Ext(strings.SplitN(href, "#", 2)[0]), ".gif") ||
		strings.EqualFold(path.Ext(strings.SplitN(href, "#", 2)[0]), ".webp") {
		return readCoverHref(archive, href, opfPath)
	}

	guidePath, err := resolveResource(opfPath, href)
	if err != nil {
		return nil, err
	}
	document, err := archive.ReadFile(guidePath, extract.MaxMetadataDocumentSize)
	if err != nil {
		return nil, fmt.Errorf("read EPUB guide cover page: %w", err)
	}
	page, err := parseXML(document)
	if err != nil {
		return nil, fmt.Errorf("%w: parse EPUB guide cover page: %v", extract.ErrInvalidInput, err)
	}
	for _, name := range []string{"img", "image"} {
		for _, imageNode := range descendants(page, name) {
			imageHref := firstNonEmpty(attribute(imageNode, "src"), attribute(imageNode, "href"))
			if imageHref == "" {
				continue
			}
			return readCoverHref(archive, imageHref, guidePath)
		}
	}
	return nil, fmt.Errorf("%w: EPUB guide cover page has no image", extract.ErrInvalidInput)
}

func resolveResource(basePath, href string) (string, error) {
	reference, err := url.Parse(href)
	if err != nil || reference.IsAbs() || reference.Host != "" || reference.RawQuery != "" {
		return "", fmt.Errorf("%w: invalid EPUB resource reference %q", extract.ErrInvalidInput, href)
	}
	decodedPath, err := url.PathUnescape(reference.EscapedPath())
	if err != nil || strings.HasPrefix(decodedPath, "/") {
		return "", fmt.Errorf("%w: invalid EPUB resource path %q", extract.ErrInvalidInput, href)
	}
	resource, err := safePath(path.Join(path.Dir(basePath), decodedPath))
	if err != nil {
		return "", fmt.Errorf("%w: unsafe EPUB resource path: %v", extract.ErrInvalidInput, err)
	}
	return resource, nil
}

func safePath(value string) (string, error) {
	if value == "" || strings.ContainsRune(value, '\x00') || strings.Contains(value, `\`) || strings.HasPrefix(value, "/") {
		return "", fmt.Errorf("empty or absolute path")
	}
	clean := path.Clean(value)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || path.IsAbs(clean) {
		return "", fmt.Errorf("path escapes archive root")
	}
	for _, part := range strings.Split(clean, "/") {
		if part == "" || part == "." || part == ".." || strings.Contains(part, ":") {
			return "", fmt.Errorf("invalid path component")
		}
	}
	return clean, nil
}

func parseXML(data []byte) (*node, error) {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	decoder.Strict = true
	var root *node
	var stack []*node
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch token := token.(type) {
		case xml.StartElement:
			current := &node{Name: token.Name, Attrs: append([]xml.Attr(nil), token.Attr...)}
			if len(stack) == 0 {
				if root != nil {
					return nil, fmt.Errorf("multiple XML roots")
				}
				root = current
			} else {
				parent := stack[len(stack)-1]
				parent.Children = append(parent.Children, current)
			}
			stack = append(stack, current)
		case xml.EndElement:
			if len(stack) == 0 {
				return nil, fmt.Errorf("unexpected XML end element")
			}
			stack = stack[:len(stack)-1]
		case xml.CharData:
			if len(stack) > 0 {
				stack[len(stack)-1].Text.Write(token)
			}
		case xml.Directive:
			return nil, fmt.Errorf("XML directives are not accepted")
		}
	}
	if root == nil || len(stack) != 0 {
		return nil, fmt.Errorf("incomplete XML document")
	}
	return root, nil
}

func child(parent *node, name string) *node {
	for _, item := range parent.Children {
		if item.Name.Local == name {
			return item
		}
	}
	return nil
}

func children(parent *node, name string) []*node {
	if parent == nil {
		return nil
	}
	var result []*node
	for _, item := range parent.Children {
		if item.Name.Local == name {
			result = append(result, item)
		}
	}
	return result
}

func descendants(parent *node, name string) []*node {
	var result []*node
	for _, item := range parent.Children {
		if item.Name.Local == name {
			result = append(result, item)
		}
		result = append(result, descendants(item, name)...)
	}
	return result
}

func attribute(item *node, name string) string {
	if item == nil {
		return ""
	}
	for _, attr := range item.Attrs {
		if attr.Name.Local == name {
			return strings.TrimSpace(attr.Value)
		}
	}
	return ""
}

func text(item *node) string {
	if item == nil {
		return ""
	}
	value := item.Text.String()
	for _, child := range item.Children {
		value += text(child)
	}
	return strings.Join(strings.Fields(value), " ")
}

func optionalText(item *node) *string {
	if value := text(item); value != "" {
		return stringPointer(value)
	}
	return nil
}

func stringPointer(value string) *string { return &value }

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func normalizeRole(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "aut", "author":
		return "author"
	case "trl", "translator":
		return "translator"
	case "edt", "editor":
		return "editor"
	case "ill", "illustrator":
		return "illustrator"
	default:
		return role
	}
}

func setSeriesIndex(metadata *extract.Metadata, value string) {
	index, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err == nil && !math.IsInf(index, 0) && !math.IsNaN(index) {
		metadata.SeriesIndex = &index
	}
}

func setPageCount(metadata *extract.Metadata, value string) {
	count, err := strconv.Atoi(strings.TrimSpace(value))
	if err == nil && count >= 0 {
		metadata.PageCount = &count
	}
}

func cleanFilename(filename string) string {
	name := strings.TrimSuffix(path.Base(strings.ReplaceAll(filename, `\`, "/")), path.Ext(filename))
	name = strings.NewReplacer("_", " ", ".", " ").Replace(name)
	return strings.Join(strings.Fields(name), " ")
}
