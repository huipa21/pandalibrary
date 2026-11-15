package wordbooks

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	"strings"
	"testing"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

func testCover(t *testing.T, width, height int) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := jpeg.Encode(&data, image.NewRGBA(image.Rect(0, 0, width, height)), nil); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func coverURL(data []byte) string { return coverImagePrefix + base64.StdEncoding.EncodeToString(data) }

func TestCoverValidation(t *testing.T) {
	jpegData := testCover(t, 600, 900)
	for _, color := range []string{"", "navy", "forest", "ochre", "khaki", "rust", "taupe", "burgundy", "slate-teal"} {
		if err := validateCover(color, coverURL(jpegData)); err != nil {
			t.Fatalf("palette %q: %v", color, err)
		}
	}
	for name, input := range map[string]BookCreate{
		"unknown color":     {CoverColor: "blue"},
		"color case":        {CoverColor: "Navy"},
		"color whitespace":  {CoverColor: " navy"},
		"external URL":      {CoverImage: "https://example.com/cover.jpg"},
		"wrong MIME":        {CoverImage: "data:image/png;base64," + base64.StdEncoding.EncodeToString(jpegData)},
		"missing data":      {CoverImage: coverImagePrefix},
		"invalid base64":    {CoverImage: coverImagePrefix + "%%%"},
		"base64 newline":    {CoverImage: coverImagePrefix + "\n" + base64.StdEncoding.EncodeToString(jpegData)},
		"not JPEG":          {CoverImage: coverURL([]byte("not an image"))},
		"truncated JPEG":    {CoverImage: coverURL(jpegData[:len(jpegData)/2])},
		"wrong width":       {CoverImage: coverURL(testCover(t, 601, 900))},
		"wrong height":      {CoverImage: coverURL(testCover(t, 600, 899))},
		"oversized":         {CoverImage: coverURL(make([]byte, MaxCoverImageBytes+1))},
		"oversized encoded": {CoverImage: coverImagePrefix + strings.Repeat("A", base64.StdEncoding.EncodedLen(MaxCoverImageBytes)+4)},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateCover(input.CoverColor, input.CoverImage); !errors.Is(err, catalog.ErrInvalid) {
				t.Fatalf("validation = %v", err)
			}
		})
	}
}

func TestWordbookCoverServicePersistence(t *testing.T) {
	ctx := context.Background()
	database, err := db.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	runner, err := migrations.NewRunner(database.Writer, ":memory:", nil, migrations.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Writer.ExecContext(ctx, `INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES
		(1, 'reader', 'x', 'user', 1, 1), (2, 'other', 'x', 'user', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	service := NewService(database.Writer, nil, nil, nil)
	cover := coverURL(testCover(t, 600, 900))
	book, err := service.CreateWithDescription(ctx, 1, BookCreate{Name: "Notes", CoverColor: "forest", CoverImage: cover})
	if err != nil {
		t.Fatal(err)
	}
	bad := "blue"
	for _, input := range []BookCreate{{Name: "Invalid", CoverColor: bad}, {Name: "Invalid", CoverImage: bad}} {
		if _, err := service.CreateWithDescription(ctx, 1, input); !errors.Is(err, catalog.ErrInvalid) {
			t.Fatalf("invalid create: %v", err)
		}
	}
	for _, patch := range []BookPatch{{CoverColor: &bad}, {CoverImage: &bad}} {
		if _, err := service.PatchBook(ctx, 1, book.ID, patch); !errors.Is(err, catalog.ErrInvalid) {
			t.Fatalf("invalid patch: %v", err)
		}
	}
	if _, err := service.PatchBook(ctx, 2, book.ID, BookPatch{CoverColor: &bad}); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("ownership: %v", err)
	}
	name := "Renamed"
	book, err = service.PatchBook(ctx, 1, book.ID, BookPatch{Name: &name})
	if err != nil || book.CoverColor != "forest" || book.CoverImage != cover {
		t.Fatalf("unrelated patch lost cover: %v", err)
	}
	// A new service must read persisted values rather than process-local state.
	service = NewService(database.Writer, nil, nil, nil)
	books, err := service.List(ctx, 1)
	if err != nil || len(books) != 2 || books[1].CoverColor != "forest" || books[1].CoverImage != cover || books[0].CoverColor != "" || books[0].CoverImage != "" {
		t.Fatalf("list persistence/defaults: %v", err)
	}
	empty := ""
	book, err = service.PatchBook(ctx, 1, book.ID, BookPatch{CoverColor: &empty, CoverImage: &empty})
	if err != nil || book.CoverColor != "" || book.CoverImage != "" {
		t.Fatalf("reset cover: %v", err)
	}
	color := "ochre"
	book, err = service.PatchBook(ctx, 1, book.ID, BookPatch{CoverColor: &color, CoverImage: &cover})
	if err != nil || book.CoverColor != color || book.CoverImage != cover {
		t.Fatalf("replace cover: %v", err)
	}
	books, err = service.List(ctx, 1)
	if err != nil || len(books) != 2 || books[1].CoverColor != color || books[1].CoverImage != cover {
		t.Fatalf("updated cover persistence: %v", err)
	}
}
