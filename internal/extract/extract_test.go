package extract

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"testing"
	"time"
)

func TestSniffFormats(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want Format
	}{
		{name: "PDF", data: []byte("%PDF-1.7\n"), want: FormatPDF},
		{name: "MOBI", data: mobiHeader(6), want: FormatMOBI},
		{name: "AZW3", data: mobiHeader(8), want: FormatAZW3},
		{name: "AZW3 KF8 boundary", data: mobiBoundaryHeader(), want: FormatAZW3},
		{name: "FB2", data: []byte(`<?xml version="1.0"?><FictionBook/>`), want: FormatFB2},
		{name: "FB2 UTF-8 BOM", data: append([]byte{0xef, 0xbb, 0xbf}, []byte(`<?xml version="1.0"?><FictionBook/>`)...), want: FormatFB2},
		{name: "FB2 Windows-1251", data: []byte("<?xml version=\"1.0\" encoding=\"windows-1251\"?><FictionBook>\xd0\xe8\xe2\xe5\xf2</FictionBook>"), want: FormatFB2},
		{name: "EPUB", data: zipBytes(t, map[string][]byte{"mimetype": []byte("application/epub+zip")}), want: FormatEPUB},
		{name: "FBZ", data: zipBytes(t, map[string][]byte{"book.fb2": []byte("<FictionBook/>")}), want: FormatFBZ},
		{name: "CBZ", data: zipBytes(t, map[string][]byte{"001.jpg": []byte("image")}), want: FormatCBZ},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := Sniff(bytes.NewReader(test.data), int64(len(test.data)))
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("Sniff() = %s, want %s", got, test.want)
			}
		})
	}
}

func TestSniffUnsupportedAndInvalid(t *testing.T) {
	if _, err := Sniff(bytes.NewReader([]byte("not an ebook")), int64(len("not an ebook"))); !errors.Is(err, ErrUnsupportedFormat) {
		t.Fatalf("Sniff() error = %v, want unsupported format", err)
	}
	notFB2 := []byte(`<?xml version="1.0"?><book/>`)
	if _, err := Sniff(bytes.NewReader(notFB2), int64(len(notFB2))); !errors.Is(err, ErrUnsupportedFormat) {
		t.Fatalf("Sniff() error = %v, want unsupported format for non-FictionBook XML", err)
	}
	malformedXML := []byte(`<?xml version="1.0"?><FictionBook`)
	if _, err := Sniff(bytes.NewReader(malformedXML), int64(len(malformedXML))); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("Sniff() error = %v, want invalid input for malformed XML", err)
	}
	unknownEncoding := []byte(`<?xml version="1.0" encoding="unknown-encoding"?><FictionBook/>`)
	if _, err := Sniff(bytes.NewReader(unknownEncoding), int64(len(unknownEncoding))); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("Sniff() error = %v, want invalid input for unknown XML encoding", err)
	}
	broken := []byte("PK\x03\x04broken")
	if _, err := Sniff(bytes.NewReader(broken), int64(len(broken))); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("Sniff() error = %v, want invalid input", err)
	}
}

func TestRegistryRequiresRegisteredHandler(t *testing.T) {
	data := []byte("%PDF-1.7")
	_, err := NewRegistry(time.Second).Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "")
	if !errors.Is(err, ErrNotRegistered) || !errors.Is(err, ErrUnsupportedFormat) {
		t.Fatalf("Extract() error = %v, want not registered and unsupported", err)
	}
}

func TestRegistryPanicAndTimeoutReturnNoMetadata(t *testing.T) {
	pdf := []byte("%PDF-1.7")
	tests := []struct {
		name      string
		timeout   time.Duration
		extractor Extractor
		want      error
	}{
		{
			name:    "panic",
			timeout: time.Second,
			extractor: func(context.Context, io.ReaderAt, int64, string) (Metadata, error) {
				panic("test panic")
			},
			want: ErrExtractorPanic,
		},
		{
			name:    "timeout",
			timeout: 10 * time.Millisecond,
			extractor: func(ctx context.Context, _ io.ReaderAt, _ int64, _ string) (Metadata, error) {
				<-ctx.Done()
				return Metadata{Title: "partial"}, nil
			},
			want: ErrTimeout,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			registry := NewRegistry(test.timeout)
			if err := registry.Register(FormatPDF, test.extractor); err != nil {
				t.Fatal(err)
			}
			metadata, err := registry.Extract(context.Background(), bytes.NewReader(pdf), int64(len(pdf)), "")
			if !errors.Is(err, test.want) {
				t.Fatalf("Extract() error = %v, want %v", err, test.want)
			}
			if metadata.Title != "" {
				t.Fatalf("Extract() returned partial metadata %#v", metadata)
			}
		})
	}
}

func TestArchiveRejectsTraversalAndOversizedEntry(t *testing.T) {
	traversal := zipBytes(t, map[string][]byte{"../escape": []byte("bad")})
	if _, err := OpenArchive(bytes.NewReader(traversal), int64(len(traversal))); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("OpenArchive() error = %v, want invalid path", err)
	}

	oversized := zipBytes(t, map[string][]byte{"large.bin": []byte("small")})
	central := bytes.Index(oversized, []byte("PK\x01\x02"))
	if central < 0 {
		t.Fatal("test ZIP has no central directory")
	}
	binary.LittleEndian.PutUint32(oversized[central+24:central+28], uint32(MaxEntryUncompressed+1))
	if _, err := OpenArchive(bytes.NewReader(oversized), int64(len(oversized))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("OpenArchive() error = %v, want oversized entry", err)
	}
}

func TestArchiveRejectsTooManyEntries(t *testing.T) {
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for i := 0; i <= MaxArchiveEntries; i++ {
		entry, err := writer.Create(fmt.Sprintf("entry-%05d.txt", i))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenArchive(bytes.NewReader(buffer.Bytes()), int64(buffer.Len())); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("OpenArchive() error = %v, want too many entries", err)
	}
}

func TestPartialMD5Vectors(t *testing.T) {
	t.Run("short file", func(t *testing.T) {
		data := []byte("KOReader partial MD5 short fixture")
		got, err := PartialMD5(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			t.Fatal(err)
		}
		// Reference vector from an independent .NET MD5 calculation over the
		// KOReader Binary sample sequence; this short input contributes once.
		const want = "6ab536609ea98795f038bc432a6b421c"
		if got != want {
			t.Fatalf("PartialMD5() = %s, want %s", got, want)
		}
	})

	t.Run("sparse large offsets", func(t *testing.T) {
		const size = int64(1<<30) + 1024
		got, err := PartialMD5(sparseReader{}, size)
		if err != nil {
			t.Fatal(err)
		}
		// Reference vector independently computed with .NET MD5 from 1024-byte
		// samples at offsets 0, 1024, 4096, ... 1 GiB; bytes are offset+i mod 251.
		const want = "15043b55abe418b805b2d14c1dda1857"
		if got != want {
			t.Fatalf("PartialMD5() = %s, want %s", got, want)
		}
	})

	t.Run("reader error", func(t *testing.T) {
		_, err := PartialMD5(failingReaderAt{}, 2048)
		if err == nil {
			t.Fatal("PartialMD5() did not return the reader error")
		}
	})
}

type sparseReader struct{}

func (sparseReader) ReadAt(p []byte, off int64) (int, error) {
	for i := range p {
		p[i] = byte((off + int64(i)) % 251)
	}
	return len(p), nil
}

type failingReaderAt struct{}

func (failingReaderAt) ReadAt(_ []byte, off int64) (int, error) {
	if off > 0 {
		return 0, errors.New("injected read failure")
	}
	return 0, io.EOF
}

func mobiHeader(version uint32) []byte {
	data := make([]byte, 200)
	copy(data[60:68], "BOOKMOBI")
	binary.BigEndian.PutUint16(data[76:78], 1)
	binary.BigEndian.PutUint32(data[78:82], 86)
	copy(data[102:106], "MOBI")
	binary.BigEndian.PutUint32(data[106:110], 24)
	binary.BigEndian.PutUint32(data[122:126], version)
	return data
}

func mobiBoundaryHeader() []byte {
	data := mobiHeader(6)
	copy(data[140:], "BOUNDARY")
	return data
}

func zipBytes(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, contents := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
