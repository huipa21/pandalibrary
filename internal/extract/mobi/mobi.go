// Package mobi extracts metadata from MOBI and AZW3 Palm database files.
package mobi

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"path"
	"strings"
	"unicode/utf8"

	_ "golang.org/x/image/webp"
	"golang.org/x/net/html/charset"

	"pandalibrary/internal/covers"
	"pandalibrary/internal/extract"
)

// ErrDRM identifies MOBI/AZW3 files whose PalmDOC encryption flag is set.
// It also wraps extract.ErrUnsupportedFormat for callers handling all unsupported files.
var ErrDRM = fmt.Errorf("%w: DRM-protected MOBI/AZW3 file", extract.ErrUnsupportedFormat)

const (
	palmHeaderSize = 78
	palmRecordSize = 8
	palmDocSize    = 16
	exthFlag       = 0x40
)

// Register installs both MOBI and AZW3 handlers in the shared registry.
func Register(registry *extract.Registry) error {
	if err := registry.Register(extract.FormatMOBI, Extract); err != nil {
		return err
	}
	return registry.Register(extract.FormatAZW3, Extract)
}

// Extract reads bounded MOBI/AZW3 headers and returns the original cover bytes.
func Extract(ctx context.Context, input io.ReaderAt, size int64, filename string) (extract.Metadata, error) {
	if ctx == nil || input == nil {
		return extract.Metadata{}, fmt.Errorf("%w: context and reader are required", extract.ErrInvalidInput)
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}
	input = contextReaderAt{ctx: ctx, reader: input}
	format, err := extract.Sniff(input, size)
	if err != nil {
		if ctx.Err() != nil {
			return extract.Metadata{}, ctx.Err()
		}
		return extract.Metadata{}, err
	}
	if format != extract.FormatMOBI && format != extract.FormatAZW3 {
		return extract.Metadata{}, fmt.Errorf("%w: expected MOBI or AZW3", extract.ErrUnsupportedFormat)
	}

	result, err := parse(ctx, input, size, filename)
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return extract.Metadata{}, &extract.FormatError{Format: format, Err: err}
	}
	return result, nil
}

type database struct {
	reader       io.ReaderAt
	size         int64
	directoryEnd int64
	recordCount  uint16
}

func parse(ctx context.Context, input io.ReaderAt, size int64, filename string) (extract.Metadata, error) {
	var header [palmHeaderSize]byte
	if err := readAt(input, header[:], 0); err != nil {
		return extract.Metadata{}, fmt.Errorf("%w: read Palm database header: %v", extract.ErrInvalidInput, err)
	}
	count := binary.BigEndian.Uint16(header[76:78])
	directoryEnd := int64(palmHeaderSize) + int64(count)*palmRecordSize
	if count == 0 || directoryEnd > size {
		return extract.Metadata{}, fmt.Errorf("%w: invalid Palm record table", extract.ErrInvalidInput)
	}
	db := database{reader: input, size: size, directoryEnd: directoryEnd, recordCount: count}
	start, end, err := db.recordRange(0)
	if err != nil {
		return extract.Metadata{}, fmt.Errorf("read MOBI header record: %w", err)
	}
	if end-start < palmDocSize {
		return extract.Metadata{}, fmt.Errorf("%w: truncated PalmDOC header", extract.ErrInvalidInput)
	}
	var palmDoc [palmDocSize]byte
	if err := readAt(input, palmDoc[:], start); err != nil {
		return extract.Metadata{}, fmt.Errorf("%w: read PalmDOC header: %v", extract.ErrInvalidInput, err)
	}
	if binary.BigEndian.Uint16(palmDoc[12:14]) != 0 {
		return extract.Metadata{}, ErrDRM
	}
	record, err := db.readRecord(0, extract.MaxMetadataDocumentSize)
	if err != nil {
		return extract.Metadata{}, fmt.Errorf("read MOBI header record: %w", err)
	}
	if len(record) < palmDocSize+24 || string(record[16:20]) != "MOBI" {
		return extract.Metadata{}, fmt.Errorf("%w: truncated or invalid MOBI header", extract.ErrInvalidInput)
	}
	headerLength := uint64(binary.BigEndian.Uint32(record[20:24]))
	if headerLength < 24 || headerLength > uint64(len(record)-palmDocSize) {
		return extract.Metadata{}, fmt.Errorf("%w: invalid MOBI header length", extract.ErrInvalidInput)
	}
	headerEnd := palmDocSize + int(headerLength)
	codepage := binary.BigEndian.Uint32(record[28:32])
	result := extract.Metadata{}
	var coverOffset *uint32
	if headerEnd >= 132 && binary.BigEndian.Uint32(record[128:132])&exthFlag != 0 {
		coverOffset, err = parseEXTH(ctx, record[headerEnd:], codepage, &result)
		if err != nil {
			return extract.Metadata{}, err
		}
	}

	if headerEnd >= 92 {
		nameOffset := uint64(binary.BigEndian.Uint32(record[84:88]))
		nameLength := uint64(binary.BigEndian.Uint32(record[88:92]))
		if nameLength > 0 {
			if nameOffset > uint64(len(record)) || nameLength > uint64(len(record))-nameOffset {
				return extract.Metadata{}, fmt.Errorf("%w: invalid MOBI title range", extract.ErrInvalidInput)
			}
			if result.Title == "" {
				result.Title, err = decodeText(record[int(nameOffset):int(nameOffset+nameLength)], codepage)
				if err != nil {
					return extract.Metadata{}, fmt.Errorf("decode MOBI title: %w", err)
				}
			}
		}
	}
	if result.Title == "" {
		result.Title = cleanFilename(filename)
	}

	if coverOffset != nil {
		if headerEnd < 112 {
			return extract.Metadata{}, fmt.Errorf("%w: MOBI cover has no image record index", extract.ErrInvalidInput)
		}
		firstImage := binary.BigEndian.Uint32(record[108:112])
		index := uint64(firstImage) + uint64(*coverOffset)
		if firstImage == ^uint32(0) || index == 0 || index >= uint64(count) {
			return extract.Metadata{}, fmt.Errorf("%w: invalid MOBI cover record index", extract.ErrInvalidInput)
		}
		cover, err := db.readRecord(uint32(index), extract.MaxCoverEntrySize)
		if err != nil {
			return extract.Metadata{}, fmt.Errorf("read MOBI cover: %w", err)
		}
		config, _, err := image.DecodeConfig(contextReader{ctx: ctx, reader: bytes.NewReader(cover)})
		if err != nil || config.Width <= 0 || config.Height <= 0 {
			return extract.Metadata{}, fmt.Errorf("%w: invalid MOBI cover image", extract.ErrInvalidInput)
		}
		if int64(config.Width) > covers.MaxInputPixels/int64(config.Height) {
			return extract.Metadata{}, fmt.Errorf("%w: MOBI cover image dimensions are too large", extract.ErrTooLarge)
		}
		if _, _, err := image.Decode(contextReader{ctx: ctx, reader: bytes.NewReader(cover)}); err != nil {
			return extract.Metadata{}, fmt.Errorf("%w: decode MOBI cover image: %v", extract.ErrInvalidInput, err)
		}
		result.Cover = cover
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

func (db database) readRecord(index uint32, limit int64) ([]byte, error) {
	start, end, err := db.recordRange(index)
	if err != nil {
		return nil, err
	}
	if end-start > limit {
		return nil, fmt.Errorf("%w: Palm record exceeds its read limit", extract.ErrTooLarge)
	}
	data := make([]byte, int(end-start))
	if err := readAt(db.reader, data, start); err != nil {
		return nil, fmt.Errorf("%w: read Palm record: %v", extract.ErrInvalidInput, err)
	}
	return data, nil
}

func (db database) recordRange(index uint32) (int64, int64, error) {
	if index >= uint32(db.recordCount) {
		return 0, 0, fmt.Errorf("%w: Palm record index is out of range", extract.ErrInvalidInput)
	}
	start, err := db.recordOffset(index)
	if err != nil {
		return 0, 0, err
	}
	end := db.size
	if index+1 < uint32(db.recordCount) {
		end, err = db.recordOffset(index + 1)
		if err != nil {
			return 0, 0, err
		}
	}
	if start < db.directoryEnd || start >= end || end > db.size {
		return 0, 0, fmt.Errorf("%w: invalid Palm record range", extract.ErrInvalidInput)
	}
	return start, end, nil
}

func (db database) recordOffset(index uint32) (int64, error) {
	var entry [palmRecordSize]byte
	if err := readAt(db.reader, entry[:], int64(palmHeaderSize)+int64(index)*palmRecordSize); err != nil {
		return 0, fmt.Errorf("%w: read Palm record table: %v", extract.ErrInvalidInput, err)
	}
	return int64(binary.BigEndian.Uint32(entry[:4])), nil
}

func readAt(reader io.ReaderAt, data []byte, offset int64) error {
	n, err := reader.ReadAt(data, offset)
	if n != len(data) {
		if err != nil {
			return err
		}
		return io.ErrUnexpectedEOF
	}
	if err != nil && err != io.EOF {
		return err
	}
	return nil
}

func parseEXTH(ctx context.Context, data []byte, codepage uint32, result *extract.Metadata) (*uint32, error) {
	if len(data) < 12 || string(data[:4]) != "EXTH" {
		return nil, fmt.Errorf("%w: missing or truncated EXTH header", extract.ErrInvalidInput)
	}
	length := uint64(binary.BigEndian.Uint32(data[4:8]))
	count := uint64(binary.BigEndian.Uint32(data[8:12]))
	if length < 12 || length > uint64(len(data)) || count > (length-12)/8 {
		return nil, fmt.Errorf("%w: invalid EXTH length or record count", extract.ErrInvalidInput)
	}
	exth := data[:int(length)]
	position := 12
	var coverOffset *uint32
	for i := uint64(0); i < count; i++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(exth)-position < 8 {
			return nil, fmt.Errorf("%w: truncated EXTH record", extract.ErrInvalidInput)
		}
		kind := binary.BigEndian.Uint32(exth[position : position+4])
		recordLength := uint64(binary.BigEndian.Uint32(exth[position+4 : position+8]))
		if recordLength < 8 || recordLength > uint64(len(exth)-position) {
			return nil, fmt.Errorf("%w: invalid EXTH record length", extract.ErrInvalidInput)
		}
		payload := exth[position+8 : position+int(recordLength)]
		position += int(recordLength)
		if kind == 201 {
			if len(payload) != 4 || coverOffset != nil {
				return nil, fmt.Errorf("%w: invalid EXTH cover offset", extract.ErrInvalidInput)
			}
			offset := binary.BigEndian.Uint32(payload)
			coverOffset = &offset
			continue
		}
		switch kind {
		case 100, 101, 103, 104, 105, 106, 503, 524:
			value, err := decodeText(payload, codepage)
			if err != nil {
				return nil, fmt.Errorf("decode EXTH record %d: %w", kind, err)
			}
			setEXTH(result, kind, value)
		}
	}
	return coverOffset, nil
}

func setEXTH(result *extract.Metadata, kind uint32, value string) {
	if value == "" {
		return
	}
	switch kind {
	case 100:
		result.Authors = append(result.Authors, extract.Author{Name: value, Role: "author"})
	case 101:
		if result.Publisher == nil {
			result.Publisher = &value
		}
	case 103:
		if result.Description == nil {
			result.Description = &value
		}
	case 104:
		result.Identifiers = append(result.Identifiers, isbnIdentifier(value))
	case 105:
		result.Tags = append(result.Tags, value)
	case 106:
		if result.Date == nil {
			result.Date = &value
		}
	case 503:
		if result.Title == "" {
			result.Title = value
		}
	case 524:
		if result.Language == nil {
			result.Language = &value
		}
	}
}

func decodeText(data []byte, codepage uint32) (string, error) {
	if len(data) == 0 {
		return "", nil
	}
	var decoded []byte
	switch codepage {
	case 65001:
		if !utf8.Valid(data) {
			return "", fmt.Errorf("%w: invalid UTF-8 metadata", extract.ErrInvalidInput)
		}
		decoded = data
	case 1252:
		reader, err := charset.NewReaderLabel("windows-1252", bytes.NewReader(data))
		if err != nil {
			return "", fmt.Errorf("%w: MOBI character encoding: %v", extract.ErrUnsupportedFormat, err)
		}
		decoded, err = io.ReadAll(reader)
		if err != nil {
			return "", fmt.Errorf("%w: decode MOBI metadata: %v", extract.ErrInvalidInput, err)
		}
	default:
		return "", fmt.Errorf("%w: MOBI character encoding %d", extract.ErrUnsupportedFormat, codepage)
	}
	return strings.TrimSpace(strings.Trim(string(decoded), "\x00")), nil
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

func cleanFilename(filename string) string {
	name := strings.TrimSuffix(path.Base(strings.ReplaceAll(filename, `\`, "/")), path.Ext(filename))
	name = strings.NewReplacer("_", " ", ".", " ").Replace(name)
	return strings.Join(strings.Fields(name), " ")
}
