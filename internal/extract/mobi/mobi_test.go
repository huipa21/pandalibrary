package mobi

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"reflect"
	"testing"

	"pandalibrary/internal/covers"
	"pandalibrary/internal/extract"
)

type exthRecord struct {
	kind uint32
	data []byte
}

type mobiFixture struct {
	version    uint32
	codepage   uint32
	encryption uint16
	title      string
	exth       []exthRecord
	images     [][]byte
}

func TestRegisteredMOBIAndAZW3Metadata(t *testing.T) {
	cover := pngCover(t)
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		format  extract.Format
		version uint32
	}{
		{extract.FormatMOBI, 6},
		{extract.FormatAZW3, 8},
	} {
		t.Run(string(test.format), func(t *testing.T) {
			data := makeMOBI(mobiFixture{
				version:  test.version,
				codepage: 65001,
				title:    "Header title",
				exth: []exthRecord{
					{503, []byte("The EXTH title")},
					{100, []byte("Ada Author")},
					{100, []byte("Bo Author")},
					{101, []byte("Example Press")},
					{103, []byte("A description.")},
					{104, []byte("978-0-306-40615-7")},
					{105, []byte("Science fiction")},
					{105, []byte("Adventure")},
					{106, []byte("2024-06-01")},
					{524, []byte("en")},
					{201, uint32Bytes(1)},
				},
				images: [][]byte{[]byte("not the cover"), cover},
			})
			format, err := extract.Sniff(bytes.NewReader(data), int64(len(data)))
			if err != nil || format != test.format {
				t.Fatalf("Sniff() = %s, %v; want %s", format, err, test.format)
			}
			got, err := registry.Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "ignored.mobi")
			if err != nil {
				t.Fatal(err)
			}
			want := extract.Metadata{
				Title:       "The EXTH title",
				Authors:     []extract.Author{{Name: "Ada Author", Role: "author"}, {Name: "Bo Author", Role: "author"}},
				Publisher:   stringPtr("Example Press"),
				Description: stringPtr("A description."),
				Identifiers: []extract.Identifier{{Scheme: "isbn13", Value: "9780306406157"}},
				Tags:        []string{"Science fiction", "Adventure"},
				Date:        stringPtr("2024-06-01"),
				Language:    stringPtr("en"),
				Cover:       cover,
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("metadata = %#v, want %#v", got, want)
			}
		})
	}
}

func TestMOBITextEncodingAndTitleFallbacks(t *testing.T) {
	tests := []struct {
		name     string
		fixture  mobiFixture
		filename string
		title    string
	}{
		{
			name: "windows-1252 EXTH", fixture: mobiFixture{
				codepage: 1252, title: "Header",
				exth: []exthRecord{{503, []byte("\x93Caf\xe9\x94")}},
			},
			title: "\u201cCaf\u00e9\u201d",
		},
		{name: "header title", fixture: mobiFixture{codepage: 65001, title: "Actual title"}, title: "Actual title"},
		{name: "filename", fixture: mobiFixture{codepage: 65001}, filename: `C:\books\my_book.file.mobi`, title: "my book file"},
		{name: "blank EXTH", fixture: mobiFixture{codepage: 65001, title: "Header", exth: []exthRecord{{503, []byte(" \t ")}}}, title: "Header"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := makeMOBI(test.fixture)
			got, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), test.filename)
			if err != nil {
				t.Fatal(err)
			}
			if got.Title != test.title || got.Cover != nil {
				t.Fatalf("metadata = %#v, want title %q and no cover", got, test.title)
			}
		})
	}
}

func TestMOBIKF8BoundaryUsesSharedSniffer(t *testing.T) {
	data := makeMOBI(mobiFixture{
		version: 6, codepage: 65001, encryption: 2,
		exth: []exthRecord{{503, []byte("BOUNDARY")}},
	})
	format, err := extract.Sniff(bytes.NewReader(data), int64(len(data)))
	if err != nil || format != extract.FormatAZW3 {
		t.Fatalf("Sniff() = %s, %v; want AZW3", format, err)
	}
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	got, err := registry.Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "book.mobi")
	var formatErr *extract.FormatError
	if !errors.Is(err, ErrDRM) || !errors.As(err, &formatErr) || formatErr.Format != extract.FormatAZW3 {
		t.Fatalf("error = %v, want AZW3 DRM error", err)
	}
	assertEmptyMetadata(t, got)
}

func TestMOBIRegistrationErrors(t *testing.T) {
	if err := Register(nil); !errors.Is(err, extract.ErrInvalidInput) {
		t.Fatalf("nil registry error = %v", err)
	}
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	if err := Register(registry); !errors.Is(err, extract.ErrInvalidInput) {
		t.Fatalf("duplicate registration error = %v", err)
	}
}

func TestMOBIDRMReturnsStableErrorsAndNoMetadata(t *testing.T) {
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	for _, encryption := range []uint16{1, 2, 99} {
		data := makeMOBI(mobiFixture{
			version: 8, codepage: 65001, encryption: encryption,
			exth: []exthRecord{{503, []byte("must not escape")}},
		})
		got, err := registry.Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "protected.azw3")
		if !errors.Is(err, ErrDRM) || !errors.Is(err, extract.ErrUnsupportedFormat) {
			t.Fatalf("encryption %d: error = %v, want DRM and unsupported sentinels", encryption, err)
		}
		assertEmptyMetadata(t, got)
	}
}

func TestMOBIDRMDetectedBeforeOversizedMetadata(t *testing.T) {
	data := makeMOBI(mobiFixture{
		codepage: 65001, encryption: 2,
		exth: []exthRecord{{103, bytes.Repeat([]byte("x"), extract.MaxMetadataDocumentSize)}},
	})
	got, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "protected.mobi")
	if !errors.Is(err, ErrDRM) {
		t.Fatalf("error = %v, want DRM", err)
	}
	assertEmptyMetadata(t, got)
}

func TestMOBIRejectsInvalidInputs(t *testing.T) {
	base := makeMOBI(mobiFixture{
		codepage: 65001,
		exth:     []exthRecord{{503, []byte("partial")}, {201, uint32Bytes(0)}},
		images:   [][]byte{pngCover(t)},
	})
	first := int(binary.BigEndian.Uint32(base[78:82]))
	exth := first + palmDocSize + 232
	mutate := func(f func([]byte)) []byte {
		data := bytes.Clone(base)
		f(data)
		return data
	}
	tests := []struct {
		name string
		data []byte
		want error
	}{
		{"truncated table", base[:84], extract.ErrInvalidInput},
		{"record before table", mutate(func(b []byte) { binary.BigEndian.PutUint32(b[78:82], 80) }), extract.ErrInvalidInput},
		{"unordered records", mutate(func(b []byte) { copy(b[86:90], b[78:82]) }), extract.ErrInvalidInput},
		{"record beyond file", mutate(func(b []byte) { binary.BigEndian.PutUint32(b[86:90], uint32(len(b)+1)) }), extract.ErrInvalidInput},
		{"short MOBI header", mutate(func(b []byte) { binary.BigEndian.PutUint32(b[first+20:first+24], 23) }), extract.ErrInvalidInput},
		{"long MOBI header", mutate(func(b []byte) { binary.BigEndian.PutUint32(b[first+20:first+24], ^uint32(0)) }), extract.ErrInvalidInput},
		{"missing EXTH", mutate(func(b []byte) { copy(b[exth:exth+4], "NOPE") }), extract.ErrInvalidInput},
		{"short EXTH", mutate(func(b []byte) { binary.BigEndian.PutUint32(b[exth+4:exth+8], 11) }), extract.ErrInvalidInput},
		{"EXTH count overflow", mutate(func(b []byte) { binary.BigEndian.PutUint32(b[exth+8:exth+12], ^uint32(0)) }), extract.ErrInvalidInput},
		{"EXTH record too short", mutate(func(b []byte) { binary.BigEndian.PutUint32(b[exth+16:exth+20], 7) }), extract.ErrInvalidInput},
		{"EXTH record too long", mutate(func(b []byte) { binary.BigEndian.PutUint32(b[exth+16:exth+20], ^uint32(0)) }), extract.ErrInvalidInput},
		{"invalid title range", mutate(func(b []byte) {
			binary.BigEndian.PutUint32(b[first+84:first+88], ^uint32(0))
			binary.BigEndian.PutUint32(b[first+88:first+92], 1)
		}), extract.ErrInvalidInput},
		{"invalid cover index", mutate(func(b []byte) { binary.BigEndian.PutUint32(b[first+108:first+112], ^uint32(0)) }), extract.ErrInvalidInput},
		{"cover offset overflow", makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{201, uint32Bytes(^uint32(0))}}, images: [][]byte{pngCover(t)}}), extract.ErrInvalidInput},
		{"short cover offset", makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{201, []byte{0, 0, 0}}}}), extract.ErrInvalidInput},
		{"duplicate cover offset", makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{201, uint32Bytes(0)}, {201, uint32Bytes(0)}}}), extract.ErrInvalidInput},
		{"invalid cover image", makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{201, uint32Bytes(0)}}, images: [][]byte{[]byte("not an image")}}), extract.ErrInvalidInput},
		{"truncated cover image", makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{201, uint32Bytes(0)}}, images: [][]byte{pngCover(t)[:33]}}), extract.ErrInvalidInput},
		{"excessive cover dimensions", makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{201, uint32Bytes(0)}}, images: [][]byte{oversizedPNGHeader(t)}}), extract.ErrTooLarge},
		{"unsupported encoding", makeMOBI(mobiFixture{codepage: 9999, exth: []exthRecord{{503, []byte("title")}}}), extract.ErrUnsupportedFormat},
		{"invalid UTF-8", makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{503, []byte{0xff}}}}), extract.ErrInvalidInput},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := Extract(context.Background(), bytes.NewReader(test.data), int64(len(test.data)), "invalid.mobi")
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			assertEmptyMetadata(t, got)
		})
	}
}

func TestMOBIMetadataRecordSizeBoundary(t *testing.T) {
	const overhead = palmDocSize + 232 + 12 + 8
	payload := bytes.Repeat([]byte("x"), extract.MaxMetadataDocumentSize-overhead)
	data := makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{103, payload}}})
	got, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "book.mobi")
	if err != nil || got.Description == nil || len(*got.Description) != len(payload) {
		t.Fatalf("at-limit metadata: description length %d, error = %v", optionalLength(got.Description), err)
	}
	data = append(data, 0)
	got, err = Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "book.mobi")
	if !errors.Is(err, extract.ErrTooLarge) {
		t.Fatalf("over-limit error = %v, want size limit", err)
	}
	assertEmptyMetadata(t, got)
}

func TestMOBICoverSizeBoundary(t *testing.T) {
	cover := pngCover(t)
	cover = append(cover, make([]byte, extract.MaxCoverEntrySize-len(cover))...)
	data := makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{201, uint32Bytes(0)}}, images: [][]byte{cover}})
	got, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "book.mobi")
	if err != nil || !bytes.Equal(got.Cover, cover) {
		t.Fatalf("at-limit cover size = %d, error = %v", len(got.Cover), err)
	}
	data = append(data, 0)
	got, err = Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "book.mobi")
	if !errors.Is(err, extract.ErrTooLarge) {
		t.Fatalf("over-limit error = %v, want size limit", err)
	}
	assertEmptyMetadata(t, got)
}

func TestMOBIEnforcesRecordSizeLimits(t *testing.T) {
	tests := []struct {
		name    string
		fixture mobiFixture
	}{
		{
			name: "metadata",
			fixture: mobiFixture{codepage: 65001, exth: []exthRecord{
				{103, bytes.Repeat([]byte("x"), extract.MaxMetadataDocumentSize)},
			}},
		},
		{
			name: "cover",
			fixture: mobiFixture{codepage: 65001, exth: []exthRecord{{201, uint32Bytes(0)}},
				images: [][]byte{make([]byte, extract.MaxCoverEntrySize+1)}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := makeMOBI(test.fixture)
			got, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "large.mobi")
			if !errors.Is(err, extract.ErrTooLarge) {
				t.Fatalf("error = %v, want size limit", err)
			}
			assertEmptyMetadata(t, got)
		})
	}
}

func TestMOBICancelledContext(t *testing.T) {
	data := makeMOBI(mobiFixture{codepage: 65001})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := Extract(ctx, bytes.NewReader(data), int64(len(data)), "book.mobi")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
	assertEmptyMetadata(t, got)
}

func TestMOBICancellationBeforeCoverDecode(t *testing.T) {
	data := makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{201, uint32Bytes(0)}}, images: [][]byte{pngCover(t)}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader := cancelingReaderAt{
		reader: bytes.NewReader(data), cancel: cancel,
		coverOffset: int64(binary.BigEndian.Uint32(data[86:90])),
	}
	got, err := Extract(ctx, reader, int64(len(data)), "book.mobi")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
	assertEmptyMetadata(t, got)
}

func FuzzExtractMOBI(f *testing.F) {
	f.Add(makeMOBI(mobiFixture{codepage: 65001, exth: []exthRecord{{503, []byte("Fixture")}}}))
	f.Add([]byte("BOOKMOBI"))
	f.Fuzz(func(t *testing.T, data []byte) {
		got, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "fuzz.mobi")
		if err != nil {
			assertEmptyMetadata(t, got)
		}
	})
}

func makeMOBI(fixture mobiFixture) []byte {
	if fixture.version == 0 {
		fixture.version = 6
	}
	record := make([]byte, palmDocSize+232)
	binary.BigEndian.PutUint16(record[0:2], 1)
	binary.BigEndian.PutUint16(record[12:14], fixture.encryption)
	copy(record[16:20], "MOBI")
	binary.BigEndian.PutUint32(record[20:24], 232)
	binary.BigEndian.PutUint32(record[28:32], fixture.codepage)
	binary.BigEndian.PutUint32(record[36:40], fixture.version)
	binary.BigEndian.PutUint32(record[108:112], 1)
	if len(fixture.exth) > 0 {
		binary.BigEndian.PutUint32(record[128:132], exthFlag)
		var exth bytes.Buffer
		exth.WriteString("EXTH")
		exth.Write(make([]byte, 8))
		for _, item := range fixture.exth {
			exth.Write(uint32Bytes(item.kind))
			exth.Write(uint32Bytes(uint32(8 + len(item.data))))
			exth.Write(item.data)
		}
		for exth.Len()%4 != 0 {
			exth.WriteByte(0)
		}
		binary.BigEndian.PutUint32(exth.Bytes()[4:8], uint32(exth.Len()))
		binary.BigEndian.PutUint32(exth.Bytes()[8:12], uint32(len(fixture.exth)))
		record = append(record, exth.Bytes()...)
	}
	if fixture.title != "" {
		binary.BigEndian.PutUint32(record[84:88], uint32(len(record)))
		binary.BigEndian.PutUint32(record[88:92], uint32(len(fixture.title)))
		record = append(record, fixture.title...)
	}
	records := append([][]byte{record}, fixture.images...)
	tableEnd := palmHeaderSize + len(records)*palmRecordSize + 2
	data := make([]byte, tableEnd)
	copy(data[60:68], "BOOKMOBI")
	binary.BigEndian.PutUint16(data[76:78], uint16(len(records)))
	for i, item := range records {
		binary.BigEndian.PutUint32(data[palmHeaderSize+i*palmRecordSize:], uint32(len(data)))
		data = append(data, item...)
	}
	return data
}

func uint32Bytes(value uint32) []byte {
	var data [4]byte
	binary.BigEndian.PutUint32(data[:], value)
	return data[:]
}

type cancelingReaderAt struct {
	reader      *bytes.Reader
	cancel      context.CancelFunc
	coverOffset int64
}

func (r cancelingReaderAt) ReadAt(p []byte, off int64) (int, error) {
	n, err := r.reader.ReadAt(p, off)
	if off == r.coverOffset {
		r.cancel()
	}
	return n, err
}

func pngCover(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.RGBA{R: 80, G: 120, B: 200, A: 255})
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func oversizedPNGHeader(t *testing.T) []byte {
	t.Helper()
	data := pngCover(t)
	binary.BigEndian.PutUint32(data[16:20], uint32(covers.MaxInputPixels+1))
	binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
	return data
}

func stringPtr(value string) *string { return &value }

func optionalLength(value *string) int {
	if value == nil {
		return 0
	}
	return len(*value)
}

func assertEmptyMetadata(t *testing.T, metadata extract.Metadata) {
	t.Helper()
	if !reflect.DeepEqual(metadata, extract.Metadata{}) {
		t.Fatalf("returned partial metadata: %#v", metadata)
	}
}
