package extract

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"

	"golang.org/x/net/html/charset"
)

const (
	sniffPrefixSize = 4096
	maxXMLRootProbe = 64 << 10
)

func Sniff(r io.ReaderAt, size int64) (Format, error) {
	if r == nil || size <= 0 {
		return "", fmt.Errorf("%w: input is empty", ErrInvalidInput)
	}
	if size > MaxCompressedInput && size > MaxArchiveUncompressed {
		return "", fmt.Errorf("%w: input is %d bytes", ErrTooLarge, size)
	}

	prefix := make([]byte, min(int64(sniffPrefixSize), size))
	n, err := r.ReadAt(prefix, 0)
	if err != nil && !(err == io.EOF && n == len(prefix)) {
		return "", fmt.Errorf("%w: read input prefix: %v", ErrInvalidInput, err)
	}
	if n != len(prefix) {
		return "", fmt.Errorf("%w: truncated input prefix", ErrInvalidInput)
	}
	prefix = prefix[:n]

	if bytes.HasPrefix(prefix, []byte("%PDF-")) {
		return FormatPDF, nil
	}
	if len(prefix) >= 68 && string(prefix[60:68]) == "BOOKMOBI" {
		return sniffMOBI(r, size)
	}
	if len(prefix) >= 4 && bytes.Equal(prefix[:4], []byte("PK\x03\x04")) {
		return sniffZIP(r, size)
	}
	if looksLikeXML(prefix) {
		format, err := sniffFB2Root(r, size)
		if err == nil {
			return format, nil
		}
		if errors.Is(err, ErrUnsupportedFormat) || errors.Is(err, ErrInvalidInput) {
			return "", err
		}
		return "", fmt.Errorf("%w: invalid XML input: %v", ErrInvalidInput, err)
	}
	return "", fmt.Errorf("%w: no recognized ebook signature", ErrUnsupportedFormat)
}

func sniffMOBI(r io.ReaderAt, size int64) (Format, error) {
	if size < 84 {
		return "", fmt.Errorf("%w: truncated MOBI header", ErrInvalidInput)
	}
	recordHeader := make([]byte, 2+8)
	if err := readAt(r, recordHeader, 76); err != nil {
		return "", fmt.Errorf("%w: read Palm database record table: %v", ErrInvalidInput, err)
	}
	recordCount := int64(binary.BigEndian.Uint16(recordHeader[:2]))
	if recordCount == 0 || recordCount > 100_000 {
		return "", fmt.Errorf("%w: invalid Palm database record count", ErrInvalidInput)
	}
	directoryEnd := int64(78) + recordCount*8
	if directoryEnd > size {
		return "", fmt.Errorf("%w: truncated Palm database record table", ErrInvalidInput)
	}
	records := make([]byte, recordCount*8)
	if err := readAt(r, records, 78); err != nil {
		return "", fmt.Errorf("%w: read Palm database records: %v", ErrInvalidInput, err)
	}
	firstRecordOffset := int64(binary.BigEndian.Uint32(records[:4]))
	firstRecordEnd := size
	for index := int64(0); index < recordCount; index++ {
		offset := int64(binary.BigEndian.Uint32(records[index*8 : index*8+4]))
		if offset < directoryEnd || offset >= size {
			return "", fmt.Errorf("%w: invalid Palm database record offset", ErrInvalidInput)
		}
		if index > 0 {
			previous := int64(binary.BigEndian.Uint32(records[(index-1)*8 : (index-1)*8+4]))
			if offset <= previous {
				return "", fmt.Errorf("%w: unordered Palm database records", ErrInvalidInput)
			}
		}
		if index == 1 {
			firstRecordEnd = offset
		}
	}
	if firstRecordEnd-firstRecordOffset < 16+24 {
		return "", fmt.Errorf("%w: truncated MOBI record", ErrInvalidInput)
	}

	mobiOffset := firstRecordOffset + 16
	header := make([]byte, 24)
	if err := readAt(r, header, mobiOffset); err != nil {
		return "", fmt.Errorf("%w: read MOBI header: %v", ErrInvalidInput, err)
	}
	if string(header[:4]) != "MOBI" {
		return "", fmt.Errorf("%w: invalid MOBI header", ErrInvalidInput)
	}
	headerLength := int64(binary.BigEndian.Uint32(header[4:8]))
	if headerLength < 24 || headerLength > firstRecordEnd-mobiOffset {
		return "", fmt.Errorf("%w: invalid MOBI header length", ErrInvalidInput)
	}
	version := binary.BigEndian.Uint32(header[20:24])
	boundaryLength := min(int64(1<<20), firstRecordEnd-firstRecordOffset)
	boundary := make([]byte, boundaryLength)
	if err := readAt(r, boundary, firstRecordOffset); err != nil {
		return "", fmt.Errorf("%w: read KF8 boundary: %v", ErrInvalidInput, err)
	}
	if version >= 8 || bytes.Contains(boundary, []byte("BOUNDARY")) {
		return FormatAZW3, nil
	}
	return FormatMOBI, nil
}

func readAt(r io.ReaderAt, buffer []byte, offset int64) error {
	n, err := r.ReadAt(buffer, offset)
	if err != nil && !(err == io.EOF && n == len(buffer)) {
		return err
	}
	if n != len(buffer) {
		return io.ErrUnexpectedEOF
	}
	return nil
}

func sniffZIP(r io.ReaderAt, size int64) (Format, error) {
	archive, err := OpenArchive(r, size)
	if err != nil {
		return "", err
	}
	if archive.Has("mimetype") {
		mime, err := archive.ReadFile("mimetype", 256)
		if err != nil {
			return "", err
		}
		if string(mime) == "application/epub+zip" {
			return FormatEPUB, nil
		}
	}

	names := archive.Names()
	hasFB2 := false
	hasImage := false
	for _, name := range names {
		ext := strings.ToLower(path.Ext(name))
		if ext == ".fb2" && !strings.HasSuffix(name, "/") {
			hasFB2 = true
		}
		if isImageExtension(ext) && !strings.HasSuffix(name, "/") {
			hasImage = true
		}
	}
	if hasFB2 {
		return FormatFBZ, nil
	}
	if hasImage {
		return FormatCBZ, nil
	}
	return "", fmt.Errorf("%w: ZIP archive is not an EPUB, FBZ, or CBZ", ErrUnsupportedFormat)
}

func isImageExtension(ext string) bool {
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff":
		return true
	default:
		return false
	}
}

func looksLikeXML(prefix []byte) bool {
	prefix = bytes.TrimPrefix(prefix, []byte{0xef, 0xbb, 0xbf})
	trimmed := bytes.TrimSpace(prefix)
	return bytes.HasPrefix(trimmed, []byte("<?xml")) || bytes.HasPrefix(trimmed, []byte("<"))
}

func sniffFB2Root(r io.ReaderAt, size int64) (Format, error) {
	offset := int64(0)
	if size >= 3 {
		var bom [3]byte
		if err := readAt(r, bom[:], 0); err != nil {
			return "", err
		}
		if bytes.Equal(bom[:], []byte{0xef, 0xbb, 0xbf}) {
			offset = 3
		}
	}
	probeEnd := min(int64(maxXMLRootProbe), size)
	probeSize := probeEnd - offset
	decoder := xml.NewDecoder(io.NewSectionReader(r, offset, probeSize))
	decoder.CharsetReader = charset.NewReaderLabel
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", err
		}
		switch token := token.(type) {
		case xml.StartElement:
			if token.Name.Local == "FictionBook" {
				return FormatFB2, nil
			}
			return "", fmt.Errorf("%w: XML root is not FictionBook", ErrUnsupportedFormat)
		case xml.Directive:
			return "", fmt.Errorf("%w: XML directives are not accepted", ErrInvalidInput)
		case xml.CharData:
			if len(bytes.TrimSpace(token)) != 0 {
				return "", fmt.Errorf("%w: text before XML root", ErrInvalidInput)
			}
		}
	}
}
