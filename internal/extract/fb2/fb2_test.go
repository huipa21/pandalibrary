package fb2

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"

	"pandalibrary/internal/extract"
	"pandalibrary/internal/extract/mobi"
)

func TestFB2AndFBZMetadata(t *testing.T) {
	cover := []byte{0, 1, 2, 3, 0xfe, 0xff}
	document := fullFB2(base64.StdEncoding.EncodeToString(cover))
	archive := zipFixture(t, []zipEntry{{"nested/BOOK.FB2", document}})
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		data []byte
	}{
		{"FB2", document},
		{"FBZ", archive},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := registry.Extract(context.Background(), bytes.NewReader(test.data), int64(len(test.data)), "ignored.fb2")
			if err != nil {
				t.Fatal(err)
			}
			want := extract.Metadata{
				Title:       "Example Book",
				Authors:     []extract.Author{{Name: "Ada M Author", Role: "author"}, {Name: "Bo", Role: "author"}},
				Language:    ptr("en"),
				Publisher:   ptr("Example Press"),
				Date:        ptr("2024"),
				Description: ptr("First bold paragraph. Second paragraph."),
				Identifiers: []extract.Identifier{{Scheme: "isbn10", Value: "0306406152"}},
				Tags:        []string{"sf_fiction", "adventure", "space", "robots"},
				Series:      ptr("Example Series"),
				SeriesIndex: floatPtr(2.5),
				Cover:       cover,
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("metadata = %#v, want %#v", got, want)
			}
		})
	}
}

func TestWindows1251FB2AndFBZ(t *testing.T) {
	document := windows1251FB2()
	want := "\u041f\u0440\u0438\u0432\u0435\u0442"
	got, err := Extract(context.Background(), bytes.NewReader(document), int64(len(document)), "book.fb2")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != want || len(got.Authors) != 1 || got.Authors[0].Name != "\u0418\u0432\u0430\u043d" {
		t.Fatalf("CP1251 metadata = %#v", got)
	}
	archive := zipFixture(t, []zipEntry{{"book.fb2", document}})
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	got, err = registry.Extract(context.Background(), bytes.NewReader(archive), int64(len(archive)), "book.fbz")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != want {
		t.Fatalf("CP1251 FBZ title = %q, want %q", got.Title, want)
	}
}

func TestWindows1251PlainFB2Registry(t *testing.T) {
	document := windows1251FB2()
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	got, err := registry.Extract(context.Background(), bytes.NewReader(document), int64(len(document)), "book.fb2")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "\u041f\u0440\u0438\u0432\u0435\u0442" {
		t.Fatalf("CP1251 title = %q", got.Title)
	}
}

func TestUTF8BOMFB2AndFBZ(t *testing.T) {
	document := append([]byte{0xef, 0xbb, 0xbf}, []byte(`<?xml version="1.0" encoding="UTF-8"?>`+
		`<FictionBook><description><title-info><book-title>BOM title</book-title></title-info></description></FictionBook>`)...)
	got, err := Extract(context.Background(), bytes.NewReader(document), int64(len(document)), "book.fb2")
	if err != nil || got.Title != "BOM title" {
		t.Fatalf("direct BOM metadata = %#v, error = %v", got, err)
	}
	archive := zipFixture(t, []zipEntry{{"book.fb2", document}})
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	got, err = registry.Extract(context.Background(), bytes.NewReader(archive), int64(len(archive)), "book.fbz")
	if err != nil || got.Title != "BOM title" {
		t.Fatalf("FBZ BOM metadata = %#v, error = %v", got, err)
	}
	t.Run("plain registry", func(t *testing.T) {
		got, err := registry.Extract(context.Background(), bytes.NewReader(document), int64(len(document)), "book.fb2")
		if err != nil || got.Title != "BOM title" {
			t.Fatalf("registry BOM metadata = %#v, error = %v", got, err)
		}
	})
}

func TestAllX3FormatsDispatchThroughRegistry(t *testing.T) {
	registry := extract.NewRegistry(0)
	if err := mobi.Register(registry); err != nil {
		t.Fatal(err)
	}
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	fb2 := []byte(`<FictionBook><description><title-info/></description></FictionBook>`)
	for _, test := range []struct {
		format extract.Format
		data   []byte
	}{
		{extract.FormatMOBI, minimalMOBI(6)},
		{extract.FormatAZW3, minimalMOBI(8)},
		{extract.FormatFB2, fb2},
		{extract.FormatFBZ, zipFixture(t, []zipEntry{{"book.fb2", fb2}})},
	} {
		t.Run(string(test.format), func(t *testing.T) {
			format, err := extract.Sniff(bytes.NewReader(test.data), int64(len(test.data)))
			if err != nil || format != test.format {
				t.Fatalf("Sniff() = %s, %v; want %s", format, err, test.format)
			}
			got, err := registry.Extract(context.Background(), bytes.NewReader(test.data), int64(len(test.data)), `C:\books\fallback_book.file.ext`)
			if err != nil {
				t.Fatal(err)
			}
			if got.Title != "fallback book file" {
				t.Fatalf("title = %q", got.Title)
			}
		})
	}
}

func TestFB2RegistrationErrors(t *testing.T) {
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

func TestFB2DateFallbackAndCoverBeforeDescription(t *testing.T) {
	document := []byte(`<?xml version="1.0"?>
<FictionBook xmlns:l="http://www.w3.org/1999/xlink">
 <binary id="front">YQ==</binary>
 <description><title-info><date value="2022-10-25">October</date>
 <coverpage><image l:href="#front"/></coverpage></title-info></description>
</FictionBook>`)
	got, err := Extract(context.Background(), bytes.NewReader(document), int64(len(document)), "my_book.fb2")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "my book" || got.Date == nil || *got.Date != "2022-10-25" || string(got.Cover) != "a" {
		t.Fatalf("metadata = %#v", got)
	}
}

func TestFB2RejectsInvalidDocuments(t *testing.T) {
	validPrefix := `<FictionBook><description><title-info>`
	validSuffix := `</title-info></description></FictionBook>`
	deep := `<FictionBook><description><title-info/></description>` +
		strings.Repeat("<a>", maxXMLDepth) + strings.Repeat("</a>", maxXMLDepth) + `</FictionBook>`
	tests := []struct {
		name     string
		document string
		want     error
	}{
		{"empty", "", extract.ErrInvalidInput},
		{"wrong root", `<other/>`, extract.ErrInvalidInput},
		{"missing description", `<FictionBook/>`, extract.ErrInvalidInput},
		{"missing title info", `<FictionBook><description/></FictionBook>`, extract.ErrInvalidInput},
		{"truncated", validPrefix, extract.ErrInvalidInput},
		{"multiple roots", validPrefix + validSuffix + `<FictionBook/>`, extract.ErrInvalidInput},
		{"multiple descriptions", validPrefix + `</title-info></description><description><title-info/></description></FictionBook>`, extract.ErrInvalidInput},
		{"multiple title infos", `<FictionBook><description><title-info/><title-info/></description></FictionBook>`, extract.ErrInvalidInput},
		{"directive", `<!DOCTYPE FictionBook [<!ENTITY x "x">]>` + validPrefix + validSuffix, extract.ErrInvalidInput},
		{"directive in body", validPrefix + `</title-info></description><body><!DOCTYPE a></body></FictionBook>`, extract.ErrInvalidInput},
		{"text outside root", validPrefix + validSuffix + `extra`, extract.ErrInvalidInput},
		{"invalid series", validPrefix + `<sequence name="Series" number="NaN"/>` + validSuffix, extract.ErrInvalidInput},
		{"infinite series", validPrefix + `<sequence name="Series" number="+Inf"/>` + validSuffix, extract.ErrInvalidInput},
		{"external cover", validPrefix + `<coverpage><image href="https://example.invalid/cover"/></coverpage>` + validSuffix, extract.ErrInvalidInput},
		{"too deeply nested", deep, extract.ErrTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := []byte(test.document)
			got, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "invalid.fb2")
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			assertEmpty(t, got)
		})
	}
}

func TestFB2CoverErrorsAndWhitespace(t *testing.T) {
	base := func(cover, binaries string) []byte {
		return []byte(`<FictionBook><description><title-info><book-title>partial</book-title><coverpage>` +
			cover + `</coverpage></title-info></description>` + binaries + `</FictionBook>`)
	}
	tests := []struct {
		name     string
		document []byte
	}{
		{"missing binary", base(`<image href="#cover"/>`, ``)},
		{"duplicate binary", base(`<image href="#cover"/>`, `<binary id="cover">YQ==</binary><binary id="cover">Yg==</binary>`)},
		{"invalid base64", base(`<image href="#cover"/>`, `<binary id="cover">Y$==</binary>`)},
		{"incomplete base64", base(`<image href="#cover"/>`, `<binary id="cover">YQ=</binary>`)},
		{"noncanonical base64", base(`<image href="#cover"/>`, `<binary id="cover">YR==</binary>`)},
		{"data after padding", base(`<image href="#cover"/>`, `<binary id="cover">YQ==Yg==</binary>`)},
		{"empty base64", base(`<image href="#cover"/>`, `<binary id="cover"> </binary>`)},
		{"nested XML", base(`<image href="#cover"/>`, `<binary id="cover"><p>YQ==</p></binary>`)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := Extract(context.Background(), bytes.NewReader(test.document), int64(len(test.document)), "invalid.fb2")
			if !errors.Is(err, extract.ErrInvalidInput) {
				t.Fatalf("error = %v, want invalid input", err)
			}
			assertEmpty(t, got)
		})
	}
	document := base(`<image href="#cover"/>`, "<binary id=\"cover\"> Y\tQ\n=<!-- comment -->= </binary>")
	got, err := Extract(context.Background(), bytes.NewReader(document), int64(len(document)), "book.fb2")
	if err != nil || string(got.Cover) != "a" {
		t.Fatalf("cover = %q, error = %v", got.Cover, err)
	}
}

func TestFB2MetadataAndDocumentSizeLimits(t *testing.T) {
	const prefix = `<description><title-info><book-title>`
	const suffix = `</book-title></title-info></description>`
	title := strings.Repeat("x", extract.MaxMetadataDocumentSize-len(prefix)-len(suffix))
	data := []byte(`<FictionBook>` + prefix + title + suffix + `</FictionBook>`)
	got, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "large.fb2")
	if err != nil || len(got.Title) != len(title) {
		t.Fatalf("at-limit title length = %d, error = %v", len(got.Title), err)
	}
	tooLarge := []byte(`<FictionBook>` + prefix + title + "x" + suffix + `</FictionBook>`)
	got, err = Extract(context.Background(), bytes.NewReader(tooLarge), int64(len(tooLarge)), "large.fb2")
	if !errors.Is(err, extract.ErrTooLarge) {
		t.Fatalf("metadata error = %v, want size limit", err)
	}
	assertEmpty(t, got)

	got, err = Extract(context.Background(), bytes.NewReader(data), extract.MaxEntryUncompressed+1, "large.fb2")
	if !errors.Is(err, extract.ErrTooLarge) {
		t.Fatalf("document error = %v, want size limit", err)
	}
	assertEmpty(t, got)
}

func TestFB2CoverDecodedSizeBoundary(t *testing.T) {
	for _, test := range []struct {
		name    string
		size    int
		wantErr error
	}{
		{"at limit", extract.MaxCoverEntrySize, nil},
		{"over limit", extract.MaxCoverEntrySize + 1, extract.ErrTooLarge},
	} {
		t.Run(test.name, func(t *testing.T) {
			reader := virtualCoverBook(test.size)
			got, err := Extract(context.Background(), reader, reader.size(), "cover.fb2")
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
			if err != nil {
				assertEmpty(t, got)
			} else if len(got.Cover) != test.size {
				t.Fatalf("cover size = %d, want %d", len(got.Cover), test.size)
			}
		})
	}
}

func TestFBZRejectsUnsafeMissingAndAmbiguousMembers(t *testing.T) {
	book := []byte(`<FictionBook><description><title-info/></description></FictionBook>`)
	oversized := zipFixture(t, []zipEntry{{"book.fb2", book}})
	central := bytes.Index(oversized, []byte("PK\x01\x02"))
	if central < 0 {
		t.Fatal("ZIP central directory not found")
	}
	binary.LittleEndian.PutUint32(oversized[central+24:central+28], uint32(extract.MaxEntryUncompressed+1))
	tests := []struct {
		name string
		data []byte
		want error
	}{
		{"missing", zipFixture(t, []zipEntry{{"readme.txt", []byte("no book")}}), extract.ErrInvalidInput},
		{"traversal", zipFixture(t, []zipEntry{{"../book.fb2", book}}), extract.ErrInvalidInput},
		{"absolute path", zipFixture(t, []zipEntry{{"/book.fb2", book}}), extract.ErrInvalidInput},
		{"multiple", zipFixture(t, []zipEntry{{"a.fb2", book}, {"b.FB2", book}}), extract.ErrInvalidInput},
		{"duplicate", zipFixture(t, []zipEntry{{"a.fb2", book}, {"a.fb2", book}}), extract.ErrInvalidInput},
		{"directory", zipFixture(t, []zipEntry{{"book.fb2/", nil}}), extract.ErrInvalidInput},
		{"oversized", oversized, extract.ErrTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ExtractFBZ(context.Background(), bytes.NewReader(test.data), int64(len(test.data)), "invalid.fbz")
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			assertEmpty(t, got)
		})
	}
}

func TestFBZRejectsBadChecksumWithoutPartialMetadata(t *testing.T) {
	document := []byte(`<FictionBook><description><title-info><book-title>Fixture</book-title></title-info></description></FictionBook>`)
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, err := writer.CreateHeader(&zip.FileHeader{Name: "book.fb2", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write(document); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	data := buffer.Bytes()
	position := bytes.Index(data, []byte("Fixture"))
	if position < 0 {
		t.Fatal("stored FB2 title not found")
	}
	data[position] = 'X'
	got, err := ExtractFBZ(context.Background(), bytes.NewReader(data), int64(len(data)), "broken.fbz")
	if !errors.Is(err, extract.ErrInvalidInput) {
		t.Fatalf("error = %v, want checksum failure", err)
	}
	assertEmpty(t, got)
}

func TestFB2CancelledContextAndTruncatedReader(t *testing.T) {
	data := []byte(`<FictionBook><description><title-info/></description></FictionBook>`)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := Extract(ctx, bytes.NewReader(data), int64(len(data)), "book.fb2")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
	assertEmpty(t, got)

	got, err = Extract(context.Background(), bytes.NewReader(data), int64(len(data))+1, "book.fb2")
	if !errors.Is(err, extract.ErrInvalidInput) {
		t.Fatalf("truncated reader error = %v", err)
	}
	assertEmpty(t, got)
}

func TestFB2CancellationDuringLargeXMLToken(t *testing.T) {
	data := []byte(`<FictionBook><description><title-info><book-title>` +
		strings.Repeat("x", 1<<20) + `</book-title></title-info></description></FictionBook>`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	reader := &cancelingReaderAt{reader: bytes.NewReader(data), cancel: cancel, triggerOffset: 4096}
	got, err := Extract(ctx, reader, int64(len(data)), "book.fb2")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context cancellation", err)
	}
	assertEmpty(t, got)
	if reader.calls > 4 {
		t.Fatalf("reader performed %d reads after cancellation, want prompt interruption", reader.calls)
	}
}

func FuzzExtractFB2(f *testing.F) {
	f.Add([]byte(`<FictionBook><description><title-info><book-title>Fixture</book-title></title-info></description></FictionBook>`))
	f.Add([]byte(`<!DOCTYPE FictionBook><FictionBook/>`))
	f.Fuzz(func(t *testing.T, data []byte) {
		got, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "fuzz.fb2")
		if err != nil {
			assertEmpty(t, got)
		}
	})
}

func fullFB2(cover string) []byte {
	return []byte(fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
 <description><title-info>
  <genre>sf_fiction</genre><genre>adventure</genre>
  <author><first-name>Ada</first-name><middle-name>M</middle-name><last-name>Author</last-name></author>
  <author><nickname>Bo</nickname></author>
  <book-title> Example Book </book-title>
  <annotation><p>First <strong>bold</strong> paragraph.</p><p>Second paragraph.</p></annotation>
  <keywords>space, robots</keywords>
  <date value="2023-01-02">January 2023</date>
  <coverpage><image l:href="#front"/></coverpage><lang>en</lang>
  <sequence name="Example Series" number="2.5"/>
 </title-info><publish-info><publisher>Example Press</publisher><year>2024</year>
  <isbn>0-306-40615-2</isbn></publish-info></description>
 <body><section><p>Fixture text.</p></section></body>
 <binary id="other">ignored</binary><binary id="front">%s</binary>
</FictionBook>`, cover))
}

func windows1251FB2() []byte {
	return []byte(`<?xml version="1.0" encoding="windows-1251"?>` +
		`<FictionBook><description><title-info><author><first-name>` +
		"\xc8\xe2\xe0\xed" +
		`</first-name></author><book-title>` +
		"\xcf\xf0\xe8\xe2\xe5\xf2" +
		`</book-title><lang>ru</lang></title-info></description></FictionBook>`)
}

func minimalMOBI(version uint32) []byte {
	data := make([]byte, 200)
	copy(data[60:68], "BOOKMOBI")
	binary.BigEndian.PutUint16(data[76:78], 1)
	binary.BigEndian.PutUint32(data[78:82], 86)
	copy(data[102:106], "MOBI")
	binary.BigEndian.PutUint32(data[106:110], 24)
	binary.BigEndian.PutUint32(data[122:126], version)
	return data
}

type zipEntry struct {
	name string
	data []byte
}

func zipFixture(t *testing.T, files []zipEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, file := range files {
		entry, err := writer.Create(file.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(file.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

type generatedCoverBook struct {
	prefix  []byte
	suffix  []byte
	encoded int64
	padding int64
}

type cancelingReaderAt struct {
	reader        *bytes.Reader
	cancel        context.CancelFunc
	triggerOffset int64
	calls         int
}

func (r *cancelingReaderAt) ReadAt(p []byte, off int64) (int, error) {
	r.calls++
	n, err := r.reader.ReadAt(p, off)
	if off >= r.triggerOffset && len(p) > 1 {
		r.cancel()
	}
	return n, err
}

func virtualCoverBook(decodedSize int) generatedCoverBook {
	return generatedCoverBook{
		prefix: []byte(`<FictionBook><description><title-info><coverpage><image href="#cover"/>` +
			`</coverpage></title-info></description><binary id="cover">`),
		suffix:  []byte(`</binary></FictionBook>`),
		encoded: int64(base64.StdEncoding.EncodedLen(decodedSize)),
		padding: int64((3 - decodedSize%3) % 3),
	}
}

func (b generatedCoverBook) size() int64 {
	return int64(len(b.prefix)) + b.encoded + int64(len(b.suffix))
}

func (b generatedCoverBook) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off >= b.size() {
		return 0, io.EOF
	}
	n := min(len(p), int(b.size()-off))
	for i := 0; i < n; i++ {
		pos := off + int64(i)
		switch {
		case pos < int64(len(b.prefix)):
			p[i] = b.prefix[pos]
		case pos < int64(len(b.prefix))+b.encoded:
			p[i] = 'A'
			if pos >= int64(len(b.prefix))+b.encoded-b.padding {
				p[i] = '='
			}
		default:
			p[i] = b.suffix[pos-int64(len(b.prefix))-b.encoded]
		}
	}
	if n != len(p) {
		return n, io.EOF
	}
	return n, nil
}

func ptr(value string) *string        { return &value }
func floatPtr(value float64) *float64 { return &value }

func assertEmpty(t *testing.T, metadata extract.Metadata) {
	t.Helper()
	if !reflect.DeepEqual(metadata, extract.Metadata{}) {
		t.Fatalf("returned partial metadata: %#v", metadata)
	}
}
