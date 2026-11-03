package fb2

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"

	"golang.org/x/net/html/charset"

	"pandalibrary/internal/extract"
)

const maxXMLDepth = 256

type authorParts struct {
	first    string
	middle   string
	last     string
	nickname string
}

type textCapture struct {
	kind  string
	depth int
	value string
	text  strings.Builder
}

type metadataReader struct {
	metadata         extract.Metadata
	stack            []string
	rootSeen         bool
	rootClosed       bool
	descriptionSeen  bool
	titleInfoSeen    bool
	descriptionStart int64
	author           *authorParts
	capture          *textCapture
	coverID          string
	titleDate        string
	publishYear      string
}

func xmlDecoder(ctx context.Context, input io.Reader) *xml.Decoder {
	decoder := xml.NewDecoder(contextReader{ctx: ctx, reader: input})
	decoder.CharsetReader = charset.NewReaderLabel
	return decoder
}

func readMetadata(ctx context.Context, input io.Reader) (extract.Metadata, string, error) {
	decoder := xmlDecoder(ctx, input)
	state := metadataReader{descriptionStart: -1}
	for {
		if err := ctx.Err(); err != nil {
			return extract.Metadata{}, "", err
		}
		start := decoder.InputOffset()
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			if ctx.Err() != nil {
				return extract.Metadata{}, "", ctx.Err()
			}
			return extract.Metadata{}, "", fmt.Errorf("%w: parse FB2 XML: %v", extract.ErrInvalidInput, err)
		}
		if state.descriptionStart >= 0 && decoder.InputOffset()-state.descriptionStart > extract.MaxMetadataDocumentSize {
			return extract.Metadata{}, "", fmt.Errorf("%w: FB2 metadata exceeds its read limit", extract.ErrTooLarge)
		}
		switch token := token.(type) {
		case xml.StartElement:
			if err := state.start(token, start, decoder.InputOffset()); err != nil {
				return extract.Metadata{}, "", err
			}
		case xml.EndElement:
			state.end()
		case xml.CharData:
			if start == 0 && !state.rootSeen {
				token = bytes.TrimPrefix(token, []byte{0xef, 0xbb, 0xbf})
			}
			if state.capture != nil {
				state.capture.text.Write(token)
			} else if len(state.stack) == 0 && strings.TrimSpace(string(token)) != "" {
				return extract.Metadata{}, "", fmt.Errorf("%w: text outside the FB2 root", extract.ErrInvalidInput)
			}
		case xml.Directive:
			return extract.Metadata{}, "", fmt.Errorf("%w: XML directives are not accepted", extract.ErrInvalidInput)
		}
	}
	if !state.rootSeen || !state.rootClosed || len(state.stack) != 0 || !state.descriptionSeen || !state.titleInfoSeen {
		return extract.Metadata{}, "", fmt.Errorf("%w: FB2 requires FictionBook, description, and title-info elements", extract.ErrInvalidInput)
	}
	if state.publishYear != "" {
		state.metadata.Date = &state.publishYear
	} else if state.titleDate != "" {
		state.metadata.Date = &state.titleDate
	}
	return state.metadata, state.coverID, nil
}

func (s *metadataReader) start(element xml.StartElement, tokenStart, tokenEnd int64) error {
	if len(s.stack) >= maxXMLDepth {
		return fmt.Errorf("%w: FB2 XML nesting is too deep", extract.ErrTooLarge)
	}
	if len(s.stack) == 0 {
		if s.rootSeen || element.Name.Local != "FictionBook" {
			return fmt.Errorf("%w: invalid or multiple FB2 roots", extract.ErrInvalidInput)
		}
		s.rootSeen = true
	}
	s.stack = append(s.stack, element.Name.Local)
	depth := len(s.stack)
	if s.capture != nil {
		if s.capture.kind == "annotation" && isTextBlock(element.Name.Local) {
			s.capture.text.WriteByte(' ')
		}
		return nil
	}
	if depth == 2 && s.stack[1] == "description" {
		if s.descriptionSeen {
			return fmt.Errorf("%w: multiple FB2 description elements", extract.ErrInvalidInput)
		}
		s.descriptionSeen = true
		s.descriptionStart = tokenStart
		if tokenEnd-tokenStart > extract.MaxMetadataDocumentSize {
			return fmt.Errorf("%w: FB2 metadata exceeds its read limit", extract.ErrTooLarge)
		}
	}
	if depth == 3 && s.stack[1] == "description" && s.stack[2] == "title-info" {
		if s.titleInfoSeen {
			return fmt.Errorf("%w: multiple FB2 title-info elements", extract.ErrInvalidInput)
		}
		s.titleInfoSeen = true
	}
	if depth < 4 || s.stack[1] != "description" {
		return nil
	}
	switch s.stack[2] {
	case "title-info":
		return s.startTitleInfo(element, depth)
	case "publish-info":
		if depth == 4 {
			switch element.Name.Local {
			case "publisher", "year", "isbn":
				s.capture = &textCapture{kind: element.Name.Local, depth: depth}
			case "sequence":
				return s.setSequence(element)
			}
		}
	}
	return nil
}

func (s *metadataReader) startTitleInfo(element xml.StartElement, depth int) error {
	if depth == 4 {
		switch element.Name.Local {
		case "author":
			s.author = &authorParts{}
		case "book-title", "genre", "keywords", "lang", "annotation":
			s.capture = &textCapture{kind: element.Name.Local, depth: depth}
		case "date":
			s.capture = &textCapture{kind: "date", depth: depth, value: attribute(element, "value")}
		case "sequence":
			return s.setSequence(element)
		}
	} else if depth == 5 && s.stack[3] == "author" && s.author != nil {
		switch element.Name.Local {
		case "first-name", "middle-name", "last-name", "nickname":
			s.capture = &textCapture{kind: element.Name.Local, depth: depth}
		}
	} else if depth == 5 && s.stack[3] == "coverpage" && element.Name.Local == "image" && s.coverID == "" {
		href := attribute(element, "href")
		if href != "" {
			if !strings.HasPrefix(href, "#") || len(href) == 1 {
				return fmt.Errorf("%w: FB2 cover must reference a local binary", extract.ErrInvalidInput)
			}
			s.coverID = strings.TrimPrefix(href, "#")
		}
	}
	return nil
}

func (s *metadataReader) setSequence(element xml.StartElement) error {
	if s.metadata.Series != nil {
		return nil
	}
	name := attribute(element, "name")
	if name == "" {
		return nil
	}
	s.metadata.Series = &name
	if number := attribute(element, "number"); number != "" {
		index, err := strconv.ParseFloat(number, 64)
		if err != nil || math.IsNaN(index) || math.IsInf(index, 0) {
			return fmt.Errorf("%w: invalid FB2 series number", extract.ErrInvalidInput)
		}
		s.metadata.SeriesIndex = &index
	}
	return nil
}

func (s *metadataReader) end() {
	depth := len(s.stack)
	if s.capture != nil {
		if depth == s.capture.depth {
			s.finishCapture()
		} else if s.capture.kind == "annotation" && isTextBlock(s.stack[depth-1]) {
			s.capture.text.WriteByte(' ')
		}
	}
	if depth == 4 && s.stack[1] == "description" && s.stack[2] == "title-info" && s.stack[3] == "author" && s.author != nil {
		parts := []string{s.author.first, s.author.middle, s.author.last}
		name := strings.Join(strings.Fields(strings.Join(parts, " ")), " ")
		if name == "" {
			name = s.author.nickname
		}
		if name != "" {
			s.metadata.Authors = append(s.metadata.Authors, extract.Author{Name: name, Role: "author"})
		}
		s.author = nil
	}
	if depth == 2 && s.stack[1] == "description" {
		s.descriptionStart = -1
	}
	if depth == 1 {
		s.rootClosed = true
	}
	s.stack = s.stack[:depth-1]
}

func (s *metadataReader) finishCapture() {
	capture := s.capture
	s.capture = nil
	value := strings.Join(strings.Fields(capture.text.String()), " ")
	if capture.kind == "date" && capture.value != "" {
		value = capture.value
	}
	if value == "" {
		return
	}
	switch capture.kind {
	case "book-title":
		if s.metadata.Title == "" {
			s.metadata.Title = value
		}
	case "first-name":
		s.author.first = value
	case "middle-name":
		s.author.middle = value
	case "last-name":
		s.author.last = value
	case "nickname":
		s.author.nickname = value
	case "genre":
		s.metadata.Tags = append(s.metadata.Tags, value)
	case "keywords":
		for _, tag := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ';' }) {
			if tag = strings.TrimSpace(tag); tag != "" {
				s.metadata.Tags = append(s.metadata.Tags, tag)
			}
		}
	case "lang":
		if s.metadata.Language == nil {
			s.metadata.Language = &value
		}
	case "annotation":
		if s.metadata.Description == nil {
			s.metadata.Description = &value
		}
	case "date":
		if s.titleDate == "" {
			s.titleDate = value
		}
	case "publisher":
		if s.metadata.Publisher == nil {
			s.metadata.Publisher = &value
		}
	case "year":
		if s.publishYear == "" {
			s.publishYear = value
		}
	case "isbn":
		s.metadata.Identifiers = append(s.metadata.Identifiers, isbnIdentifier(value))
	}
}

func attribute(element xml.StartElement, name string) string {
	for _, attr := range element.Attr {
		if attr.Name.Local == name {
			return strings.TrimSpace(attr.Value)
		}
	}
	return ""
}

func isTextBlock(name string) bool {
	switch name {
	case "p", "v", "subtitle", "empty-line", "section":
		return true
	default:
		return false
	}
}
