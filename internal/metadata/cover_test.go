package metadata

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/covers"
)

func coverFixture(t *testing.T, handler http.HandlerFunc) (serviceFixture, LookupResponse, Selection) {
	t.Helper()
	f := newServiceFixture(t)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	_, err := f.service.UpdateProvider(context.Background(), administrator, "neodb", providerPatch(t,
		`{"enabled":true,"api_token":"fixture-token","base_url":"`+server.URL+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	installStub(f.service, func(name string, _ context.Context, _ Query) ([]Candidate, error) {
		candidate := stubCandidate(name)
		if name == "neodb" {
			candidate.CoverURL = text(server.URL + "/cover.png")
		}
		return []Candidate{candidate}, nil
	})
	result, err := f.service.Lookup(context.Background(), administrator, 101)
	if err != nil {
		t.Fatal(err)
	}
	return f, result, Selection{Provider: "neodb", Reference: "record123"}
}

func pngImage(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 10, 20))); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestCoverNormalizationCoverOnlyApplyAndAtomicRollback(t *testing.T) {
	data := pngImage(t)
	f, lookup, selection := coverFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cover.png" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("cover fetch sent credentials or wrong path")
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(data)
	})
	ctx := context.Background()
	request := CoverRequest{RequestKey: lookup.RequestKey, Selection: selection}
	normalized, err := f.service.Cover(ctx, administrator, 101, request)
	if err != nil || normalized.Width != 10 || normalized.Height != 20 || !bytes.HasPrefix(normalized.FullJPEG, []byte{0xff, 0xd8}) {
		t.Fatalf("normalized cover = %+v, %v", normalized, err)
	}
	book, err := f.service.Apply(ctx, administrator, 101, ApplyRequest{RequestKey: lookup.RequestKey, Fields: map[string]Selection{"cover": selection}})
	if err != nil || book.Title != "Original Title" || book.CoverSource == nil || *book.CoverSource != "neodb" || book.CoverURL == nil {
		t.Fatalf("cover-only apply = %+v %v", book, err)
	}
	var sourceFound bool
	for _, source := range book.FieldSources {
		if source.Field == "cover" {
			sourceFound = source.Source == "neodb" && source.SourceRef != nil && *source.SourceRef == selection.Reference
		}
	}
	if !sourceFound {
		t.Fatal("cover provenance missing")
	}
	content, err := f.books.OpenCover(ctx, administrator, 101, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := content.File.Close(); err != nil {
		t.Fatal(err)
	}
	book, err = f.service.Apply(ctx, administrator, 101, ApplyRequest{
		RequestKey: lookup.RequestKey, Fields: map[string]Selection{"cover": selection},
		Patch: catalog.BookPatch{Description: catalog.Optional[string]{Set: true, Value: text("Manual description")}},
	})
	if err != nil || book.Description == nil || *book.Description != "Manual description" ||
		book.CoverSource == nil || *book.CoverSource != "neodb" {
		t.Fatalf("mixed cover apply = %+v %v", book, err)
	}
	for _, source := range book.FieldSources {
		if source.Field == "description" && (source.Source != "manual" || source.SourceRef != nil) {
			t.Fatalf("mixed cover manual provenance = %+v", source)
		}
		if source.Field == "cover" && (source.Source != "neodb" || source.SourceRef == nil || *source.SourceRef != selection.Reference) {
			t.Fatalf("mixed cover provider provenance = %+v", source)
		}
	}
	if _, err := f.db.Writer.ExecContext(ctx, `
		UPDATE books SET cover_sha256 = NULL, cover_source = NULL WHERE id = 101;
		CREATE TRIGGER fail_cover_provenance BEFORE UPDATE ON book_field_sources
		WHEN NEW.field = 'cover' BEGIN SELECT RAISE(ABORT, 'fixture cover provenance failure'); END;
	`); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Apply(ctx, administrator, 101, ApplyRequest{RequestKey: lookup.RequestKey,
		Fields: map[string]Selection{"title": selection, "cover": selection},
		Patch:  catalog.BookPatch{Description: catalog.Optional[string]{Set: true}},
	})
	if err == nil {
		t.Fatal("provenance failure did not fail apply")
	}
	book, err = f.books.GetBook(ctx, administrator, 101)
	if err != nil || book.Title != "Original Title" || book.CoverURL != nil ||
		book.Description == nil || *book.Description != "Manual description" {
		t.Fatalf("cover and fields did not roll back together: %+v %v", book, err)
	}
	if _, err := f.service.Cover(ctx, catalog.Viewer{UserID: 2}, 101, request); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatal("non-admin cover allowed")
	}
	if _, err := f.service.Cover(ctx, administrator, 102, request); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatal("hidden cover allowed")
	}
	request.Reference = "forged"
	if _, err := f.service.Cover(ctx, administrator, 101, request); !errors.Is(err, ErrConflict) {
		t.Fatal("non-cached cover allowed")
	}
}

func TestCoverDownloadLimitsAndImageValidation(t *testing.T) {
	bomb := pngImage(t)
	binary.BigEndian.PutUint32(bomb[16:20], 100000)
	binary.BigEndian.PutUint32(bomb[20:24], 100000)
	binary.BigEndian.PutUint32(bomb[29:33], crc32.ChecksumIEEE(bomb[12:29]))
	for _, test := range []struct {
		name string
		body []byte
		size int
		want error
	}{
		{"invalid-image", []byte("<html>not an image</html>"), 0, covers.ErrInvalidImage},
		{"pixel-limit", bomb, 0, covers.ErrImageTooLarge},
		{"content-length-limit", []byte("x"), covers.MaxInputBytes + 1, catalog.ErrTooLarge},
		{"stream-limit", []byte(strings.Repeat("x", covers.MaxInputBytes+1)), 0, covers.ErrImageTooLarge},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, lookup, selection := coverFixture(t, func(w http.ResponseWriter, _ *http.Request) {
				if test.size > 0 {
					w.Header().Set("Content-Length", strconv.Itoa(test.size))
				} else {
					w.(http.Flusher).Flush()
				}
				_, _ = w.Write(test.body)
			})
			_, err := f.service.Cover(context.Background(), administrator, 101, CoverRequest{RequestKey: lookup.RequestKey, Selection: selection})
			if !errors.Is(err, test.want) {
				t.Fatalf("cover error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestCoverCannotEscapeExplicitNeoDBOrigin(t *testing.T) {
	f, lookup, selection := coverFixture(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://127.0.0.1:9/private", http.StatusFound)
	})
	_, err := f.service.Cover(context.Background(), administrator, 101, CoverRequest{RequestKey: lookup.RequestKey, Selection: selection})
	if err == nil {
		t.Fatal("private redirect outside explicit instance accepted")
	}
	candidate := stubCandidate("openlibrary")
	candidate.CoverURL = text("https://evil.example/arbitrary.jpg")
	_, row, err := f.service.selected(context.Background(), lookup.RequestKey, Selection{Provider: "openlibrary", Reference: "record123"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.downloadCover(context.Background(), candidate, row); !errors.Is(err, ErrInvalid) {
		t.Fatalf("arbitrary cover URL accepted: %v", err)
	}
}
