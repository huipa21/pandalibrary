// Package fb2 extracts metadata from FictionBook XML and FBZ archives.
package fb2

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"path"
	"strings"

	"pandalibrary/internal/extract"
)

// Register installs both FB2 and FBZ handlers in the shared registry.
func Register(registry *extract.Registry) error {
	if err := registry.Register(extract.FormatFB2, Extract); err != nil {
		return err
	}
	return registry.Register(extract.FormatFBZ, ExtractFBZ)
}

// Extract reads a bounded, uncompressed FictionBook document.
func Extract(ctx context.Context, input io.ReaderAt, size int64, filename string) (extract.Metadata, error) {
	result, err := extractBook(ctx, input, size, filename)
	if err != nil {
		return extract.Metadata{}, &extract.FormatError{Format: extract.FormatFB2, Err: err}
	}
	return result, nil
}

// ExtractFBZ reads the single FictionBook member of a safe ZIP archive.
func ExtractFBZ(ctx context.Context, input io.ReaderAt, size int64, filename string) (extract.Metadata, error) {
	result, err := extractArchive(ctx, input, size, filename)
	if err != nil {
		return extract.Metadata{}, &extract.FormatError{Format: extract.FormatFBZ, Err: err}
	}
	return result, nil
}

func extractArchive(ctx context.Context, input io.ReaderAt, size int64, filename string) (extract.Metadata, error) {
	if ctx == nil || input == nil {
		return extract.Metadata{}, fmt.Errorf("%w: context and archive reader are required", extract.ErrInvalidInput)
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	archive, err := extract.OpenArchive(contextReaderAt{ctx: ctx, reader: input}, size)
	if err != nil {
		if ctx.Err() != nil {
			return extract.Metadata{}, ctx.Err()
		}
		return extract.Metadata{}, err
	}
	member := ""
	for _, name := range archive.Names() {
		if !strings.EqualFold(path.Ext(name), ".fb2") {
			continue
		}
		if member != "" {
			return extract.Metadata{}, fmt.Errorf("%w: FBZ contains multiple FB2 members", extract.ErrInvalidInput)
		}
		member = name
	}
	if member == "" {
		return extract.Metadata{}, fmt.Errorf("%w: FBZ has no FB2 member", extract.ErrInvalidInput)
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	data, err := archive.ReadFile(member, extract.MaxEntryUncompressed)
	if err != nil {
		if ctx.Err() != nil {
			return extract.Metadata{}, ctx.Err()
		}
		return extract.Metadata{}, fmt.Errorf("read FBZ member: %w", err)
	}
	return extractBook(ctx, bytes.NewReader(data), int64(len(data)), filename)
}

func extractBook(ctx context.Context, input io.ReaderAt, size int64, filename string) (extract.Metadata, error) {
	if ctx == nil || input == nil || size <= 0 {
		return extract.Metadata{}, fmt.Errorf("%w: context and a nonempty FB2 document are required", extract.ErrInvalidInput)
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	if size > extract.MaxEntryUncompressed {
		return extract.Metadata{}, fmt.Errorf("%w: FB2 document exceeds its read limit", extract.ErrTooLarge)
	}
	var lastByte [1]byte
	if n, err := input.ReadAt(lastByte[:], size-1); n != 1 || (err != nil && err != io.EOF) {
		return extract.Metadata{}, fmt.Errorf("%w: truncated FB2 document", extract.ErrInvalidInput)
	}
	reader := func() io.Reader { return io.NewSectionReader(input, 0, size) }
	result, coverID, err := readMetadata(ctx, reader())
	if err != nil {
		return extract.Metadata{}, err
	}
	if result.Title == "" {
		result.Title = cleanFilename(filename)
	}
	if coverID != "" {
		result.Cover, err = readCover(ctx, reader(), coverID)
		if err != nil {
			return extract.Metadata{}, err
		}
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	return result, nil
}

type contextReaderAt struct {
	ctx    context.Context
	reader io.ReaderAt
}

func (r contextReaderAt) ReadAt(p []byte, offset int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.ReadAt(p, offset)
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func cleanFilename(filename string) string {
	name := strings.TrimSuffix(path.Base(strings.ReplaceAll(filename, `\`, "/")), path.Ext(filename))
	name = strings.NewReplacer("_", " ", ".", " ").Replace(name)
	return strings.Join(strings.Fields(name), " ")
}

func isbnIdentifier(value string) extract.Identifier {
	original := strings.TrimSpace(value)
	isbn := strings.ToUpper(strings.TrimPrefix(strings.ToLower(original), "urn:isbn:"))
	isbn = strings.NewReplacer("-", "", " ", "").Replace(isbn)
	sum := 0
	for i, r := range isbn {
		digit := int(r - '0')
		if r == 'X' && len(isbn) == 10 && i == 9 {
			digit = 10
		} else if r < '0' || r > '9' {
			return extract.Identifier{Scheme: "identifier", Value: original}
		}
		if len(isbn) == 10 {
			sum += digit * (10 - i)
		} else if i%2 == 0 {
			sum += digit
		} else {
			sum += digit * 3
		}
	}
	if len(isbn) == 10 && sum%11 == 0 {
		return extract.Identifier{Scheme: "isbn10", Value: isbn}
	}
	if len(isbn) == 13 && sum%10 == 0 {
		return extract.Identifier{Scheme: "isbn13", Value: isbn}
	}
	return extract.Identifier{Scheme: "identifier", Value: original}
}
