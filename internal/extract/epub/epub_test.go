package epub

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"pandalibrary/internal/extract"
)

func TestEPUB2MetadataAndEPUB2CoverFallback(t *testing.T) {
	files := fixtureFiles(t, "epub2")
	files["OPS/cover.png"] = testCover(t)
	data := makeEPUB(t, files)

	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "fallback.epub")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "The Fixture Book" || metadata.Subtitle == nil || *metadata.Subtitle != "A Subtitle" {
		t.Fatalf("unexpected title fields: %#v", metadata)
	}
	if len(metadata.Authors) != 2 || metadata.Authors[0] != (extract.Author{Name: "Ada Example", Role: "author", FileAs: "Example, Ada"}) ||
		metadata.Authors[1].Role != "translator" {
		t.Fatalf("unexpected authors: %#v", metadata.Authors)
	}
	if metadata.Language == nil || *metadata.Language != "en" ||
		metadata.Publisher == nil || *metadata.Publisher != "Example Press" ||
		metadata.Date == nil || *metadata.Date != "2024-06-01" ||
		metadata.Description == nil || *metadata.Description != "A fixture description." {
		t.Fatalf("unexpected descriptive metadata: %#v", metadata)
	}
	if len(metadata.Identifiers) != 1 || metadata.Identifiers[0] != (extract.Identifier{Scheme: "isbn13", Value: "9780306406157"}) {
		t.Fatalf("unexpected identifiers: %#v", metadata.Identifiers)
	}
	if len(metadata.Tags) != 1 || metadata.Tags[0] != "Fiction" ||
		metadata.Series == nil || *metadata.Series != "Example Series" ||
		metadata.SeriesIndex == nil || *metadata.SeriesIndex != 2.5 {
		t.Fatalf("unexpected series/tags: %#v", metadata)
	}
	if len(metadata.Cover) == 0 {
		t.Fatal("EPUB2 meta cover reference was not extracted")
	}
}

func TestEPUB3RefinementsAndCoverImageProperty(t *testing.T) {
	files := fixtureFiles(t, "epub3")
	files["Text/cover.png"] = testCover(t)
	data := makeEPUB(t, files)

	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "ignored.epub")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "EPUB Three" || metadata.Subtitle == nil || *metadata.Subtitle != "Modern Metadata" {
		t.Fatalf("unexpected EPUB3 title fields: %#v", metadata)
	}
	if len(metadata.Authors) != 1 || metadata.Authors[0] != (extract.Author{
		Name: "C. Author", Role: "author", FileAs: "Author, C.",
	}) {
		t.Fatalf("unexpected EPUB3 creators: %#v", metadata.Authors)
	}
	if len(metadata.Identifiers) != 1 || metadata.Identifiers[0] != (extract.Identifier{
		Scheme: "isbn10", Value: "0306406152",
	}) {
		t.Fatalf("unexpected EPUB3 identifier: %#v", metadata.Identifiers)
	}
	if metadata.Series == nil || *metadata.Series != "Collection Series" ||
		metadata.SeriesIndex == nil || *metadata.SeriesIndex != 1.25 {
		t.Fatalf("unexpected EPUB3 series: %#v", metadata)
	}
	if metadata.PageCount == nil || *metadata.PageCount != 350 {
		t.Fatalf("unexpected EPUB3 page count: %#v", metadata.PageCount)
	}
	if len(metadata.Cover) == 0 {
		t.Fatal("EPUB3 cover-image property was not extracted")
	}
}

func TestEPUBGuideCoverFallbackAndFilenameTitle(t *testing.T) {
	files := fixtureFiles(t, "epub2-guide")
	files["OPS/Images/guide-cover.png"] = testCover(t)
	data := makeEPUB(t, files)

	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "my_book.file.epub")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "Guide Cover Book" {
		t.Fatalf("title = %q", metadata.Title)
	}
	if len(metadata.Cover) == 0 {
		t.Fatal("guide page cover was not extracted")
	}
}

func TestEPUBFilenameFallbackAndMalformedPackage(t *testing.T) {
	container := []byte(`<container><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
	fallback := []byte(`<package><metadata><language> </language></metadata></package>`)
	data := makeEPUB(t, map[string][]byte{
		"mimetype":               []byte("application/epub+zip"),
		"META-INF/container.xml": container,
		"package.opf":            fallback,
	})
	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "my_book.epub")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "my book" || metadata.Language != nil {
		t.Fatalf("unexpected filename fallback metadata: %#v", metadata)
	}

	bad := makeEPUB(t, map[string][]byte{
		"mimetype":               []byte("application/epub+zip"),
		"META-INF/container.xml": container,
		"package.opf":            []byte(`<package><metadata>`),
	})
	if _, err := Extract(context.Background(), bytes.NewReader(bad), int64(len(bad)), "bad.epub"); !errors.Is(err, extract.ErrInvalidInput) {
		t.Fatalf("Extract() error = %v, want invalid input", err)
	}
}

func TestEPUBRejectsUnsafeCoverReference(t *testing.T) {
	container := []byte(`<container><rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`)
	pkg := []byte(`<package><metadata><title>Unsafe</title></metadata><manifest><item id="cover" href="../../outside.png" properties="cover-image"/></manifest></package>`)
	data := makeEPUB(t, map[string][]byte{
		"mimetype":               []byte("application/epub+zip"),
		"META-INF/container.xml": container,
		"OPS/package.opf":        pkg,
	})
	if _, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "unsafe.epub"); !errors.Is(err, extract.ErrInvalidInput) {
		t.Fatalf("Extract() error = %v, want invalid path", err)
	}
}

func TestRegisteredEPUBExtraction(t *testing.T) {
	files := fixtureFiles(t, "epub3")
	files["Text/cover.png"] = testCover(t)
	data := makeEPUB(t, files)
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	metadata, err := registry.Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "book.epub")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "EPUB Three" {
		t.Fatalf("title = %q", metadata.Title)
	}
}

func fixtureFiles(t *testing.T, name string) map[string][]byte {
	t.Helper()
	root := filepath.Join("..", "testdata", name)
	packageTarget := "OPS/package.opf"
	if name == "epub3" {
		packageTarget = "Text/package.opf"
	}
	files := make(map[string][]byte)
	for _, file := range []struct {
		source string
		target string
	}{
		{source: "container.xml", target: "META-INF/container.xml"},
		{source: "package.opf", target: packageTarget},
	} {
		data, err := os.ReadFile(filepath.Join(root, file.source))
		if err != nil {
			t.Fatal(err)
		}
		files[file.target] = data
	}
	if name == "epub2-guide" {
		page, err := os.ReadFile(filepath.Join(root, "cover.xhtml"))
		if err != nil {
			t.Fatal(err)
		}
		files["OPS/cover.xhtml"] = page
	}
	return files
}

func makeEPUB(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	mimetype, err := writer.Create("mimetype")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mimetype.Write([]byte("application/epub+zip")); err != nil {
		t.Fatal(err)
	}
	for name, data := range files {
		if name == "mimetype" {
			continue
		}
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func testCover(t *testing.T) []byte {
	t.Helper()
	var imageBuffer bytes.Buffer
	if err := png.Encode(&imageBuffer, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return imageBuffer.Bytes()
}
