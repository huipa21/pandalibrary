package cbz

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/png"
	"reflect"
	"sort"
	"strings"
	"testing"

	"pandalibrary/internal/extract"
)

func TestExtractComicInfoAndFrontCover(t *testing.T) {
	cover1 := pngImage(t, color.RGBA{R: 10, A: 255})
	cover2 := pngImage(t, color.RGBA{G: 20, A: 255})
	cover10 := pngImage(t, color.RGBA{B: 30, A: 255})
	data := zipBytes(t, map[string][]byte{
		"10.png": cover10,
		"2.png":  cover2,
		"1.png":  cover1,
		"ComicInfo.xml": []byte(`<ComicInfo>
			<Title>Fixture Comic</Title><Series>Example Series</Series><Number>1.5</Number>
			<Writer>Ada Example</Writer><Summary>A fixture summary.</Summary>
			<Year>2024</Year><Month>6</Month><Day>7</Day><Publisher>Example Press</Publisher>
			<LanguageISO>en</LanguageISO><Genre>Fantasy, Adventure</Genre><Tags>featured|classic</Tags>
			<PageCount>32</PageCount><Pages><Page Image="2" Type="FrontCover"/></Pages>
		</ComicInfo>`),
	})
	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "fallback.cbz")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "Fixture Comic" || metadata.Series == nil || *metadata.Series != "Example Series" ||
		metadata.SeriesIndex == nil || *metadata.SeriesIndex != 1.5 {
		t.Fatalf("unexpected title/series metadata: %#v", metadata)
	}
	if len(metadata.Authors) != 1 || metadata.Authors[0] != (extract.Author{Name: "Ada Example", Role: "writer"}) {
		t.Fatalf("unexpected authors: %#v", metadata.Authors)
	}
	if metadata.Description == nil || *metadata.Description != "A fixture summary." ||
		metadata.Publisher == nil || *metadata.Publisher != "Example Press" ||
		metadata.Language == nil || *metadata.Language != "en" ||
		metadata.Date == nil || *metadata.Date != "2024-06-07" ||
		metadata.PageCount == nil || *metadata.PageCount != 32 {
		t.Fatalf("unexpected descriptive metadata: %#v", metadata)
	}
	if strings.Join(metadata.Tags, ",") != "Fantasy,Adventure,featured,classic" {
		t.Fatalf("unexpected tags: %#v", metadata.Tags)
	}
	if !bytes.Equal(metadata.Cover, cover10) {
		t.Fatal("front-cover page did not select the image at natural-sort index 2")
	}
}

func TestExtractCBZFilenameFallbackAndNaturalCoverFallback(t *testing.T) {
	first := pngImage(t, color.RGBA{R: 90, A: 255})
	data := zipBytes(t, map[string][]byte{
		"10.png": pngImage(t, color.RGBA{B: 30, A: 255}),
		"2.png":  pngImage(t, color.RGBA{G: 20, A: 255}),
		"1.png":  first,
	})
	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), `C:\books\comic_issue_01.cbz`)
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "comic issue 01" {
		t.Fatalf("filename title = %q", metadata.Title)
	}
	if !bytes.Equal(metadata.Cover, first) {
		t.Fatal("cover fallback did not choose the first natural-sorted image")
	}
}

func TestExtractCBZInvalidComicInfoAndCoverReturnNoMetadata(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want error
	}{
		{
			name: "malformed XML",
			data: zipBytes(t, map[string][]byte{
				"ComicInfo.xml": []byte(`<ComicInfo><Title>Partial</ComicInfo>`),
			}),
			want: extract.ErrInvalidInput,
		},
		{
			name: "XML directive",
			data: zipBytes(t, map[string][]byte{
				"ComicInfo.xml": []byte(`<!DOCTYPE ComicInfo><ComicInfo><Title>Unsafe</Title></ComicInfo>`),
			}),
			want: extract.ErrInvalidInput,
		},
		{
			name: "trailing XML data",
			data: zipBytes(t, map[string][]byte{
				"ComicInfo.xml": []byte(`<ComicInfo><Title>Partial</Title></ComicInfo>unexpected`),
			}),
			want: extract.ErrInvalidInput,
		},
		{
			name: "invalid series number",
			data: zipBytes(t, map[string][]byte{
				"ComicInfo.xml": []byte(`<ComicInfo><Title>Partial</Title><Number>not a number</Number></ComicInfo>`),
			}),
			want: extract.ErrInvalidInput,
		},
		{
			name: "invalid cover image",
			data: zipBytes(t, map[string][]byte{"1.png": []byte("not an image")}),
			want: extract.ErrInvalidInput,
		},
		{
			name: "unsafe entry",
			data: zipBytes(t, map[string][]byte{"../1.png": []byte("unsafe")}),
			want: extract.ErrInvalidInput,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			metadata, err := Extract(context.Background(), bytes.NewReader(test.data), int64(len(test.data)), "fallback.cbz")
			if !errors.Is(err, test.want) {
				t.Fatalf("Extract() error = %v, want %v", err, test.want)
			}
			if !reflect.DeepEqual(metadata, extract.Metadata{}) {
				t.Fatalf("Extract() returned partial metadata %#v", metadata)
			}
		})
	}
}

func TestExtractCBZOversizedCoverIsRejected(t *testing.T) {
	data := zipBytes(t, map[string][]byte{"1.png": pngImage(t, color.White)})
	central := bytes.Index(data, []byte("PK\x01\x02"))
	if central < 0 {
		t.Fatal("test ZIP has no central directory")
	}
	binary.LittleEndian.PutUint32(data[central+24:central+28], uint32(extract.MaxCoverEntrySize+1))
	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "fallback.cbz")
	if !errors.Is(err, extract.ErrTooLarge) {
		t.Fatalf("Extract() error = %v, want too large", err)
	}
	if !reflect.DeepEqual(metadata, extract.Metadata{}) {
		t.Fatalf("Extract() returned partial metadata %#v", metadata)
	}
}

func TestRegisteredCBZExtraction(t *testing.T) {
	cover := pngImage(t, color.White)
	data := zipBytes(t, map[string][]byte{
		"ComicInfo.xml": []byte(`<ComicInfo><Title>Registered CBZ</Title></ComicInfo>`),
		"1.png":         cover,
	})
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	metadata, err := registry.Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "book.cbz")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "Registered CBZ" || !bytes.Equal(metadata.Cover, cover) {
		t.Fatalf("unexpected registered metadata: %#v", metadata)
	}
}

func TestFrontCoverInvalidIndexUsesFirstNaturalImage(t *testing.T) {
	first := pngImage(t, color.RGBA{R: 100, A: 255})
	data := zipBytes(t, map[string][]byte{
		"ComicInfo.xml": []byte(`<ComicInfo><Pages><Page Image="99" Type="FrontCover"/></Pages></ComicInfo>`),
		"2.png":         pngImage(t, color.RGBA{G: 40, A: 255}),
		"1.png":         first,
	})
	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "issue.cbz")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(metadata.Cover, first) {
		t.Fatal("invalid FrontCover index did not fall back to first natural-sorted image")
	}
}

func TestComicInfoRejectsOversizedDocument(t *testing.T) {
	data := zipBytes(t, map[string][]byte{
		"ComicInfo.xml": bytes.Repeat([]byte("x"), extract.MaxMetadataDocumentSize+1),
	})
	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "large.cbz")
	if !errors.Is(err, extract.ErrTooLarge) {
		t.Fatalf("Extract() error = %v, want too large", err)
	}
	if !reflect.DeepEqual(metadata, extract.Metadata{}) {
		t.Fatalf("Extract() returned partial metadata %#v", metadata)
	}
}

func zipBytes(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(files[name]); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func pngImage(t *testing.T, fill color.Color) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			picture.Set(x, y, fill)
		}
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, picture); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
