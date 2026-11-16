package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/dictionary"
	"pandalibrary/internal/trash"
	"pandalibrary/internal/wordbooks"
)

type wordbookFixture struct {
	catalogHTTPFixture
	dictionaries *fakeDictionaryService
	logs         *bytes.Buffer
}

func newWordbookFixture(t *testing.T) wordbookFixture {
	t.Helper()
	f := newCatalogHTTPFixture(t)
	authentication, err := auth.NewService(context.Background(), f.db.Writer, f.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	blobs, err := blobstore.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	books, err := catalog.NewService(f.db.Writer, f.db.Reader, blobs)
	if err != nil {
		t.Fatal(err)
	}
	dictionaries := &fakeDictionaryService{}
	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewTextHandler(logs, nil))
	service := wordbooks.NewService(f.db.Writer, books, dictionaries, logger)
	f.router, err = NewRouter(RouterOptions{
		Database: f.db.Reader, Ready: func() bool { return true },
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("test")}},
		Logger: logger, MaxBodyBytes: 32 << 20,
		Mounts: []Mount{WordbookMount(service, authentication, logger), TrashMount(trash.NewService(f.db.Writer), authentication, logger)},
	})
	if err != nil {
		t.Fatal(err)
	}
	return wordbookFixture{f, dictionaries, logs}
}

func wordbookDecode[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d: %s", response.Code, status, response.Body.String())
	}
	var result T
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func (f wordbookFixture) send(method, target string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	data, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	return f.request(method, target, bytes.NewReader(data), cookie, nil)
}

func (f wordbookFixture) defaultID(t *testing.T) int64 {
	t.Helper()
	result := wordbookDecode[struct {
		Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
	}](t,
		f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil), http.StatusOK)
	if len(result.Wordbooks) == 0 || !result.Wordbooks[0].IsDefault {
		t.Fatal("no default wordbook")
	}
	return result.Wordbooks[0].ID
}

func wordbookSource() wordbooks.Source {
	book, file := int64(101), int64(201)
	return wordbooks.Source{BookID: &book, BookFileID: &file, BookTitle: "caller title", Locator: json.RawMessage(`{"type":"epub","cfi":"/6/2"}`), Fraction: .25, Chapter: "Chapter 1"}
}

func wordbookCapture(kind string) wordbooks.Capture {
	return wordbooks.Capture{Kind: kind, Text: "Cats", Source: wordbookSource()}
}

func TestWordbookLanguage(t *testing.T) {
	f := newWordbookFixture(t)
	defaultID := f.defaultID(t)
	book := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{
		"name": "Study", "language": " zh-Hans ",
	}, f.reader), http.StatusCreated)
	if book.Language != "zh-Hans" {
		t.Fatalf("created language = %q", book.Language)
	}
	base := fmt.Sprintf("/api/v1/wordbooks/%d", book.ID)
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"name": "Renamed"}, f.reader), http.StatusOK)
	if book.Language != "zh-Hans" {
		t.Fatalf("rename lost language: %+v", book)
	}
	list := wordbookDecode[struct {
		Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
	}](t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil), http.StatusOK)
	if len(list.Wordbooks) != 2 || list.Wordbooks[0].ID != defaultID || list.Wordbooks[0].Language != "" || list.Wordbooks[1].Language != "zh-Hans" {
		t.Fatalf("list = %+v", list.Wordbooks)
	}
	for _, invalid := range []any{nil, 1, "en_US", "a", strings.Repeat("a", 36), "en\x00x"} {
		expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Bad", "language": invalid}, f.reader), http.StatusBadRequest)
		expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"language": invalid}, f.reader), http.StatusBadRequest)
	}
	expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"language": "en"}, f.other), http.StatusNotFound)
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"language": "ja"}, f.reader), http.StatusOK)
	if book.Language != "ja" {
		t.Fatalf("patched language = %q", book.Language)
	}
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"language": ""}, f.reader), http.StatusOK)
	if book.Language != "" {
		t.Fatalf("cleared language = %q", book.Language)
	}
}

func TestWordbookMeaningLanguages(t *testing.T) {
	f := newWordbookFixture(t)
	book := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{
		"name": "Study", "meaning_language": "en", "meaning_languages": []string{" zh-Hant ", "ja", "ZH-hant"},
	}, f.reader), http.StatusCreated)
	check := func(book wordbooks.Wordbook, legacy string, languages []string) {
		t.Helper()
		if book.MeaningLanguage != legacy || !reflect.DeepEqual(book.MeaningLanguages, languages) {
			t.Fatalf("meaning preferences = %q %#v", book.MeaningLanguage, book.MeaningLanguages)
		}
	}
	check(book, "zh-Hant", []string{"zh-Hant", "ja"})
	base := fmt.Sprintf("/api/v1/wordbooks/%d", book.ID)
	wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"name": "Renamed"}, f.reader), http.StatusOK)
	list := wordbookDecode[struct {
		Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
	}](t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil), http.StatusOK)
	check(list.Wordbooks[1], "zh-Hant", []string{"zh-Hant", "ja"})
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"meaning_language": "en-GB"}, f.reader), http.StatusOK)
	check(book, "en-GB", []string{"en-GB"})
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"meaning_language": "ja", "meaning_languages": []string{}}, f.reader), http.StatusOK)
	check(book, "", []string{})
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Legacy", "meaning_language": "ja"}, f.reader), http.StatusCreated)
	check(book, "ja", []string{"ja"})
	for _, invalid := range []any{nil, "en", 3, []any{nil}, []string{""}, []string{"en_US"}, []string{strings.Repeat("a", 36)}, make([]string, 21)} {
		expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Bad", "meaning_languages": invalid}, f.reader), http.StatusBadRequest)
		expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"meaning_languages": invalid}, f.reader), http.StatusBadRequest)
	}
	expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"meaning_languages": []string{"en"}}, f.other), http.StatusNotFound)
}

func TestWordbookSettingsRealisticCover(t *testing.T) {
	f := newWordbookFixture(t)
	imageData := image.NewRGBA(image.Rect(0, 0, 600, 900))
	var state uint32 = 1
	for i := 0; i < len(imageData.Pix); i += 4 {
		state = state*1664525 + 1013904223
		imageData.Pix[i], imageData.Pix[i+1], imageData.Pix[i+2], imageData.Pix[i+3] = byte(state), byte(state>>8), byte(state>>16), 255
	}
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, imageData, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	cover := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(jpegData.Bytes())
	settings := map[string]any{
		"name": "Photo vocabulary", "description": strings.Repeat("语", 2000), "language": "en",
		"meaning_language": "zh", "cover_color": "forest", "cover_image": cover,
	}
	body, _ := json.Marshal(settings)
	if len(body) >= 1<<20 || jpegData.Len() > wordbooks.MaxCoverImageBytes {
		t.Fatalf("fixture exceeds existing bounds: body=%d jpeg=%d", len(body), jpegData.Len())
	}
	book := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", settings, f.reader), http.StatusCreated)
	settings["meaning_languages"] = []string{"zh", "ja"}
	for _, color := range []string{"crimson", "coral", "orange", "amber", "olive", "emerald", "turquoise", "sky", "cobalt", "violet", "plum", "charcoal"} {
		settings["cover_color"] = color
		saved := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, fmt.Sprintf("/api/v1/wordbooks/%d", book.ID), settings, f.reader), http.StatusOK)
		if saved.CoverColor != color || saved.CoverImage != cover || !reflect.DeepEqual(saved.MeaningLanguages, []string{"zh", "ja"}) {
			t.Fatal("settings were not persisted")
		}
	}
	t.Logf("realistic 600x900 JPEG: %d bytes; legacy settings JSON: %d bytes (limit %d)", jpegData.Len(), len(body), 1<<20)
}

func TestWordbookDescription(t *testing.T) {
	f := newWordbookFixture(t)
	book := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{
		"name": "Notes", "description": "  My notebook  ",
	}, f.reader), http.StatusCreated)
	if book.Description != "My notebook" || book.EntryCount != 0 || book.BookCount != 0 {
		t.Fatalf("created: %+v", book)
	}
	plain := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Plain"}, f.reader), http.StatusCreated)
	if plain.Description != "" {
		t.Fatalf("plain: %+v", plain)
	}
	base := fmt.Sprintf("/api/v1/wordbooks/%d", book.ID)
	patched := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"description": " Updated "}, f.reader), http.StatusOK)
	if patched.Description != "Updated" || patched.Name != "Notes" {
		t.Fatalf("patched: %+v", patched)
	}
	for _, body := range []map[string]any{
		{"name": "Bad", "description": strings.Repeat("x", 2001)},
		{"name": "Bad", "description": "a\x00b"},
		{"name": "Bad", "shared_with": []int64{2}},
	} {
		expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks", body, f.reader), http.StatusBadRequest)
	}
	expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"description": strings.Repeat("x", 2001)}, f.reader), http.StatusBadRequest)
	expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"description": "stolen"}, f.other), http.StatusNotFound)
	exact := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"description": strings.Repeat("é", 2000)}, f.reader), http.StatusOK)
	if len([]rune(exact.Description)) != 2000 {
		t.Fatalf("max description: %d", len([]rune(exact.Description)))
	}
	if strings.Contains(f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil).Body.String(), "shared_with") {
		t.Fatal("sharing fields leaked")
	}
}

func TestWordbookCovers(t *testing.T) {
	f := newWordbookFixture(t)
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, image.NewRGBA(image.Rect(0, 0, 600, 900)), nil); err != nil {
		t.Fatal(err)
	}
	// Valid JPEG comment segments bring the upload to the decoded size limit.
	data := append([]byte{}, jpegData.Bytes()[:2]...)
	remaining := wordbooks.MaxCoverImageBytes - jpegData.Len()
	for remaining > 0 {
		size := min(remaining, 65537)
		if remaining-size > 0 && remaining-size < 4 {
			size -= 4
		}
		data = append(data, 0xff, 0xfe, byte((size-2)>>8), byte(size-2))
		data = append(data, make([]byte, size-4)...)
		remaining -= size
	}
	data = append(data, jpegData.Bytes()[2:]...)
	cover := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data)
	book := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{
		"name": "Covers", "cover_color": "navy", "cover_image": cover,
	}, f.reader), http.StatusCreated)
	if book.CoverColor != "navy" || book.CoverImage != cover {
		t.Fatal("create did not return cover")
	}
	base := fmt.Sprintf("/api/v1/wordbooks/%d", book.ID)
	for _, body := range []map[string]any{
		{"cover_color": "blue"},
		{"cover_color": " navy "},
		{"cover_color": nil},
		{"cover_image": nil},
		{"cover_image": 123},
		{"cover_image": "data:image/jpeg;base64,bm90IGpwZWc="},
		{"cover_image": "data:image/png;base64,AAAA"},
		{"cover_image": "https://example.com/image.jpg"},
		{"cover_image": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(append(data, 0))},
	} {
		input := map[string]any{"name": "Invalid"}
		for key, value := range body {
			input[key] = value
		}
		expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks", input, f.reader), http.StatusBadRequest)
		expectShelfStatus(t, f.send(http.MethodPatch, base, body, f.reader), http.StatusBadRequest)
	}
	for _, cookie := range []*http.Cookie{f.other, f.admin} {
		expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"cover_color": "rust", "cover_image": ""}, cookie), http.StatusNotFound)
		list := wordbookDecode[struct {
			Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
		}](t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, cookie, nil), http.StatusOK)
		for _, other := range list.Wordbooks {
			if other.ID == book.ID || other.CoverImage != "" {
				t.Fatal("foreign cover leaked")
			}
		}
	}
	for _, patch := range []map[string]any{
		{"name": "Renamed", "description": "Notes", "archived": true},
		{"cover_color": "forest"},
	} {
		book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, patch, f.reader), http.StatusOK)
		if book.CoverImage != cover {
			t.Fatal("patch lost image")
		}
	}
	list := wordbookDecode[struct {
		Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
	}](t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil), http.StatusOK)
	if len(list.Wordbooks) != 2 || list.Wordbooks[0].CoverColor != "" || list.Wordbooks[0].CoverImage != "" ||
		list.Wordbooks[1].CoverColor != "forest" || list.Wordbooks[1].CoverImage != cover || !list.Wordbooks[1].Archived {
		t.Fatal("list did not preserve cover and existing fields")
	}
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"cover_image": ""}, f.reader), http.StatusOK)
	if book.CoverImage != "" || book.CoverColor != "forest" {
		t.Fatal("image reset lost palette")
	}
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"cover_color": ""}, f.reader), http.StatusOK)
	if book.CoverColor != "" || book.CoverImage != "" {
		t.Fatal("cover reset failed")
	}
	for _, method := range []string{http.MethodPost, http.MethodPatch} {
		target := base
		if method == http.MethodPost {
			target = "/api/v1/wordbooks"
		}
		expectShelfStatus(t, f.send(method, target, map[string]any{
			"name": "Too large", "cover_image": strings.Repeat("x", 1<<20),
		}, f.reader), http.StatusRequestEntityTooLarge)
	}
}

func TestWordbookBookWordsAndCounts(t *testing.T) {
	f := newWordbookFixture(t)
	id := f.defaultID(t)
	for _, kind := range []string{"word", "phrase", "sentence", "passage"} {
		wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", wordbookCapture(kind), f.reader), http.StatusCreated)
	}
	makeImport := func(bookID int64, sourceID *int64, cookie *http.Cookie) {
		t.Helper()
		entry := wordbooks.Entry{Kind: "passage", Text: "Imported", Source: wordbookSource(), DictionaryEntries: []dictionary.Entry{}}
		entry.Source.BookID, entry.Source.BookFileID = sourceID, nil
		input := wordbooks.Export{Version: 1, Entries: []wordbooks.Entry{entry}}
		input.Wordbook.Name = "Import"
		expectShelfStatus(t, f.send(http.MethodPost, fmt.Sprintf("/api/v1/wordbooks/%d/import", bookID), input, cookie), http.StatusOK)
	}
	hidden, visible := int64(102), int64(101)
	makeImport(id, &hidden, f.reader)
	makeImport(id, nil, f.reader)
	archived := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Old"}, f.reader), http.StatusCreated)
	makeImport(archived.ID, &visible, f.reader)
	expectShelfStatus(t, f.send(http.MethodPatch, fmt.Sprintf("/api/v1/wordbooks/%d", archived.ID), map[string]any{"archived": true}, f.reader), http.StatusOK)
	foreign := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Foreign"}, f.other), http.StatusCreated)
	makeImport(foreign.ID, &visible, f.other)
	type entries struct {
		Entries []wordbooks.Entry `json:"entries"`
	}
	result := wordbookDecode[entries](t, f.request(http.MethodGet, "/api/v1/books/101/words", nil, f.reader, nil), http.StatusOK)
	if len(result.Entries) != 5 {
		t.Fatalf("book words: %+v", result)
	}
	kinds := map[string]bool{}
	for _, e := range result.Entries {
		if e.Source.BookID == nil || *e.Source.BookID != visible || e.WordbookID == foreign.ID {
			t.Fatalf("wrong entry: %+v", e)
		}
		kinds[e.Kind] = true
	}
	if len(kinds) != 4 || result.Entries[4].WordbookID != archived.ID {
		t.Fatalf("missing kinds or archived entry: %+v", result.Entries)
	}
	for _, target := range []string{"/api/v1/books/102/words", "/api/v1/books/103/words", "/api/v1/books/999/words"} {
		expectShelfStatus(t, f.request(http.MethodGet, target, nil, f.reader, nil), http.StatusNotFound)
	}
	expectShelfStatus(t, f.request(http.MethodGet, "/api/v1/books/101/words?x=1", nil, f.reader, nil), http.StatusBadRequest)
	expectShelfStatus(t, f.request(http.MethodGet, "/api/v1/books/101/words", nil, nil, nil), http.StatusUnauthorized)
	listed := wordbookDecode[struct {
		Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
	}](t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil), http.StatusOK)
	if len(listed.Wordbooks) != 2 || listed.Wordbooks[0].EntryCount != 6 || listed.Wordbooks[0].BookCount != 2 ||
		listed.Wordbooks[1].EntryCount != 1 || listed.Wordbooks[1].BookCount != 1 {
		t.Fatalf("counts: %+v", listed)
	}
}

func TestWordbookDefaultConcurrencyAndOwnership(t *testing.T) {
	f := newWordbookFixture(t)
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			responses <- f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil)
		}()
	}
	wg.Wait()
	close(responses)
	var id int64
	for response := range responses {
		result := wordbookDecode[struct {
			Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
		}](t, response, http.StatusOK)
		if len(result.Wordbooks) != 1 || !result.Wordbooks[0].IsDefault || result.Wordbooks[0].Archived {
			t.Fatalf("default: %+v", result)
		}
		if id != 0 && id != result.Wordbooks[0].ID {
			t.Fatal("duplicate default")
		}
		id = result.Wordbooks[0].ID
		if _, err := time.Parse(time.RFC3339Nano, result.Wordbooks[0].CreatedAt); err != nil {
			t.Fatal(err)
		}
	}
	base := fmt.Sprintf("/api/v1/wordbooks/%d", id)
	for _, target := range []string{base + "/entries", base + "/export"} {
		expectShelfStatus(t, f.request(http.MethodGet, target, nil, f.other, nil), http.StatusNotFound)
		expectShelfStatus(t, f.request(http.MethodGet, target, nil, f.admin, nil), http.StatusNotFound)
	}
	expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"name": "Stolen"}, f.other), http.StatusNotFound)
	input := wordbookCapture("word")
	input.WordbookID = &id
	expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.other), http.StatusNotFound)
	expectShelfStatus(t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, nil, nil), http.StatusUnauthorized)
	expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]string{"name": "CSRF"}, f.reader), http.StatusCreated)
	expectShelfStatus(t, f.request(http.MethodPost, "/api/v1/wordbooks", strings.NewReader(`{"name":"CSRF"}`), f.reader,
		map[string]string{"Origin": "https://evil.example"}), http.StatusForbidden)
	expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"archived": true}, f.reader), http.StatusBadRequest)
}

func TestWordbookCaptureKindsSourceDictionary(t *testing.T) {
	f := newWordbookFixture(t)
	f.dictionaries.status.Directions = []dictionary.Direction{
		{From: dictionary.English, To: dictionary.Chinese, Sources: []string{"ecdict"}},
		{From: dictionary.English, To: dictionary.Chinese, Sources: []string{"ecdict"}},
		{From: dictionary.English, To: dictionary.Japanese, Sources: []string{"ecdict"}},
	}
	snapshot := dictionary.Entry{Source: "ecdict", SourceName: "ECDICT", Headword: "cat", Definitions: []string{"猫"}, Match: dictionary.MatchLemma}
	f.dictionaries.result.Entries = []dictionary.Entry{snapshot, snapshot}
	id := f.defaultID(t)
	for _, kind := range []string{"word", "phrase", "sentence", "passage"} {
		input := wordbookCapture(kind)
		input.DictionaryEntries = &[]dictionary.Entry{}
		got := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusCreated)
		if got.WordbookID != id || got.Kind != kind || got.Text != input.Text || got.Note != "" || got.Definition != "" ||
			got.Source.BookTitle != "Visible" || got.Source.BookFileID == nil || *got.Source.BookFileID != 201 ||
			got.Source.Chapter != input.Source.Chapter || !bytes.Equal(got.Source.Locator, input.Source.Locator) {
			t.Fatalf("capture: %+v", got)
		}
		want := 0
		if kind == "word" || kind == "phrase" {
			want = 2
		}
		if len(got.DictionaryEntries) != want || got.DictionaryEntries == nil {
			t.Fatalf("snapshots: %+v", got)
		}
		if want == 2 && (got.DictionaryEntries[0].From != dictionary.English || got.DictionaryEntries[0].To != dictionary.Chinese || got.DictionaryEntries[1].From != dictionary.English || got.DictionaryEntries[1].To != dictionary.Japanese) {
			t.Fatalf("snapshot directions: %+v", got.DictionaryEntries)
		}
		if want == 2 {
			loaded := wordbookDecode[struct {
				Entries []wordbooks.Entry `json:"entries"`
			}](t, f.request(http.MethodGet, fmt.Sprintf("/api/v1/wordbooks/%d/entries", id), nil, f.reader, nil), http.StatusOK)
			if len(loaded.Entries) == 0 || !reflect.DeepEqual(loaded.Entries[len(loaded.Entries)-1].DictionaryEntries, got.DictionaryEntries) {
				t.Fatalf("persisted snapshots: %+v", loaded.Entries)
			}
		}
	}
	if len(f.dictionaries.queries) != 4 {
		t.Fatalf("only word/phrase directions should be consulted: %+v", f.dictionaries.queries)
	}
	input := wordbookCapture("word")
	input.DictionaryEntries = &[]dictionary.Entry{snapshot}
	wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusCreated)
	if len(f.dictionaries.queries) != 4 {
		t.Fatal("supplied snapshot unexpectedly looked up")
	}
	input.DictionaryEntries = nil
	input.Text = strings.Repeat("long ", 100)
	wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusCreated)
	if len(f.dictionaries.queries) != 4 {
		t.Fatal("long selection looked up")
	}
	for _, bookID := range []int64{102, 103} {
		input.Source.BookID = &bookID
		expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusNotFound)
	}
	input.Source = wordbookSource()
	badFile := int64(203)
	input.Source.BookFileID = &badFile
	expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusNotFound)
}

func TestWordbookDictionaryFailureAndMissing(t *testing.T) {
	f := newWordbookFixture(t)
	capture := func() wordbooks.Entry {
		return wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", wordbookCapture("word"), f.reader), http.StatusCreated)
	}
	missing := capture()
	if missing.DictionaryWarning != "" || len(missing.DictionaryEntries) != 0 {
		t.Fatalf("missing dictionary should succeed: %+v", missing)
	}
	f.dictionaries.statusErr = errors.New("private database failure")
	failed := capture()
	if failed.DictionaryWarning == "" || strings.Contains(failed.DictionaryWarning, "private") || !strings.Contains(f.logs.String(), "private database failure") {
		t.Fatal("status failure must be logged and surfaced safely")
	}
	f.dictionaries.statusErr = nil
	f.dictionaries.status.Directions = []dictionary.Direction{{From: dictionary.English, To: dictionary.Chinese}}
	f.dictionaries.lookupErr = errors.New("lookup unavailable")
	if capture().DictionaryWarning == "" {
		t.Fatal("lookup failure not surfaced")
	}
	page := wordbookDecode[struct {
		Entries []wordbooks.Entry `json:"entries"`
	}](t,
		f.request(http.MethodGet, fmt.Sprintf("/api/v1/wordbooks/%d/entries", failed.WordbookID), nil, f.reader, nil), http.StatusOK)
	if len(page.Entries) != 3 {
		t.Fatal("dictionary failure lost capture")
	}
}

func TestWordbookEditsArchiveDelete(t *testing.T) {
	f := newWordbookFixture(t)
	book := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]string{"name": " New book "}, f.reader), http.StatusCreated)
	if book.Name != "New book" || book.IsDefault {
		t.Fatalf("book: %+v", book)
	}
	base := fmt.Sprintf("/api/v1/wordbooks/%d", book.ID)
	input := wordbookCapture("phrase")
	input.WordbookID = &book.ID
	e := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusCreated)
	path := fmt.Sprintf("%s/entries/%d", base, e.ID)
	edited := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPatch, path, map[string]string{"text": "Other phrase", "definition": "meaning", "note": "personal"}, f.reader), http.StatusOK)
	if edited.Text != "Other phrase" || edited.Definition != "meaning" || edited.Note != "personal" || edited.CreatedAt != e.CreatedAt {
		t.Fatalf("edit: %+v", edited)
	}
	updated, err := time.Parse(time.RFC3339Nano, edited.UpdatedAt)
	original, originalErr := time.Parse(time.RFC3339Nano, e.UpdatedAt)
	if err != nil || originalErr != nil || updated.Before(original) {
		t.Fatalf("edit timestamp moved backwards: %+v", edited)
	}
	expectShelfStatus(t, f.send(http.MethodPatch, path, map[string]string{"text": "steal"}, f.other), http.StatusNotFound)
	expectShelfStatus(t, f.request(http.MethodDelete, path, nil, f.other, nil), http.StatusNotFound)
	defaultID := f.defaultID(t)
	expectShelfStatus(t, f.send(http.MethodPatch, fmt.Sprintf("/api/v1/wordbooks/%d/entries/%d", defaultID, e.ID), map[string]string{"text": "wrong book"}, f.reader), http.StatusNotFound)
	archived := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, base, map[string]any{"name": "Renamed", "archived": true}, f.reader), http.StatusOK)
	if !archived.Archived || archived.Name != "Renamed" {
		t.Fatalf("archive: %+v", archived)
	}
	all := wordbookDecode[struct {
		Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
	}](t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil), http.StatusOK)
	if len(all.Wordbooks) != 2 || !all.Wordbooks[1].Archived {
		t.Fatalf("archived book missing: %+v", all)
	}
	expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusBadRequest)
	expectShelfStatus(t, f.request(http.MethodGet, base+"/entries", nil, f.reader, nil), http.StatusOK)
	expectShelfStatus(t, f.request(http.MethodDelete, path, nil, f.reader, nil), http.StatusNoContent)
	expectShelfStatus(t, f.request(http.MethodDelete, path, nil, f.reader, nil), http.StatusNotFound)
	expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]any{"archived": false}, f.reader), http.StatusOK)
	sentence := wordbookCapture("sentence")
	s := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", sentence, f.reader), http.StatusCreated)
	sPath := fmt.Sprintf("/api/v1/wordbooks/%d/entries/%d", s.WordbookID, s.ID)
	expectShelfStatus(t, f.send(http.MethodPatch, sPath, map[string]string{"definition": "invalid"}, f.reader), http.StatusBadRequest)
	noted := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPatch, sPath, map[string]string{"note": "manual note"}, f.reader), http.StatusOK)
	if noted.Note != "manual note" {
		t.Fatal("manual note was not editable")
	}
}

func TestWordbookMeaningPatch(t *testing.T) {
	f := newWordbookFixture(t)
	input := wordbookCapture("word")
	snapshot := dictionary.Entry{
		Source: dictionary.SourceWiktionaryEN, SourceName: "English Wiktionary", Headword: "apple",
		Definitions: []string{"A fruit", "A tree"}, Match: dictionary.MatchExact,
	}
	input.DictionaryEntries = &[]dictionary.Entry{snapshot}
	entry := wordbookDecode[wordbooks.Entry](t,
		f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusCreated)
	path := fmt.Sprintf("/api/v1/wordbooks/%d/entries/%d", entry.WordbookID, entry.ID)
	snapshot.Definitions = []string{"A better fruit"}
	snapshot.HiddenDefinitions = []string{"A tree"}
	updated := wordbookDecode[wordbooks.Entry](t,
		f.send(http.MethodPatch, path, map[string]any{"dictionary_entries": []dictionary.Entry{snapshot}}, f.reader), http.StatusOK)
	if len(updated.DictionaryEntries) != 1 ||
		!reflect.DeepEqual(updated.DictionaryEntries[0].Definitions, []string{"A better fruit"}) ||
		!reflect.DeepEqual(updated.DictionaryEntries[0].HiddenDefinitions, []string{"A tree"}) {
		t.Fatalf("patched meanings = %+v", updated.DictionaryEntries)
	}
	loaded := wordbookDecode[struct {
		Entries []wordbooks.Entry `json:"entries"`
	}](t, f.request(http.MethodGet, fmt.Sprintf("/api/v1/wordbooks/%d/entries", entry.WordbookID), nil, f.reader, nil), http.StatusOK)
	if len(loaded.Entries) != 1 ||
		!reflect.DeepEqual(loaded.Entries[0].DictionaryEntries[0].Definitions, []string{"A better fruit"}) ||
		!reflect.DeepEqual(loaded.Entries[0].DictionaryEntries[0].HiddenDefinitions, []string{"A tree"}) {
		t.Fatalf("saved meanings = %+v", loaded.Entries)
	}
	snapshot.Definitions = []string{"A better fruit", "A tree"}
	snapshot.HiddenDefinitions = nil
	restored := wordbookDecode[wordbooks.Entry](t,
		f.send(http.MethodPatch, path, map[string]any{"dictionary_entries": []dictionary.Entry{snapshot}}, f.reader), http.StatusOK)
	if !reflect.DeepEqual(restored.DictionaryEntries[0].Definitions, []string{"A better fruit", "A tree"}) ||
		len(restored.DictionaryEntries[0].HiddenDefinitions) != 0 {
		t.Fatalf("restored meanings = %+v", restored.DictionaryEntries)
	}
}

func TestWordbookImportExportInvalidRollback(t *testing.T) {
	f := newWordbookFixture(t)
	snapshot := dictionary.Entry{Source: "custom", SourceName: "Custom", Headword: "Cats", Definitions: []string{"definition"}, Match: dictionary.MatchExact}
	input := wordbookCapture("word")
	input.Definition, input.Note = "my meaning", "my note"
	input.DictionaryEntries = &[]dictionary.Entry{snapshot}
	e := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusCreated)
	export := wordbookDecode[wordbooks.Export](t, f.request(http.MethodGet, fmt.Sprintf("/api/v1/wordbooks/%d/export", e.WordbookID), nil, f.reader, nil), http.StatusOK)
	if export.Version != 1 || export.Wordbook.Name != "Default" || len(export.Entries) != 1 {
		t.Fatalf("export: %+v", export)
	}
	target := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]string{"name": "Imported"}, f.reader), http.StatusCreated)
	base := fmt.Sprintf("/api/v1/wordbooks/%d", target.ID)
	// Imported source context is inert, even when unavailable or owned by someone else.
	secret, unavailableFile := int64(103), int64(99999)
	export.Entries[0].Source.BookID, export.Entries[0].Source.BookFileID = &secret, &unavailableFile
	result := wordbookDecode[struct {
		Imported int `json:"imported"`
	}](t, f.send(http.MethodPost, base+"/import", export, f.reader), http.StatusOK)
	if result.Imported != 1 {
		t.Fatal("import count")
	}
	imported := wordbookDecode[wordbooks.Export](t, f.request(http.MethodGet, base+"/export", nil, f.reader, nil), http.StatusOK)
	got := imported.Entries[0]
	if got.ID == e.ID || got.WordbookID != target.ID || got.CreatedAt != e.CreatedAt || got.UpdatedAt != e.UpdatedAt || got.Text != e.Text || got.Definition != e.Definition || got.Note != e.Note ||
		*got.Source.BookID != secret || *got.Source.BookFileID != unavailableFile || len(got.DictionaryEntries) != 1 || got.DictionaryEntries[0].SourceName != "Custom" {
		t.Fatalf("import lost snapshot: %+v", got)
	}
	if len(f.dictionaries.queries) != 0 {
		t.Fatal("import consulted dictionaries")
	}
	expectShelfStatus(t, f.send(http.MethodPost, base+"/import", export, f.other), http.StatusNotFound)
	bad := export
	bad.Entries = append(append([]wordbooks.Entry{}, export.Entries...), wordbooks.Entry{Kind: "invalid", Text: "bad", Source: wordbookSource(), DictionaryEntries: []dictionary.Entry{}})
	expectShelfStatus(t, f.send(http.MethodPost, base+"/import", bad, f.reader), http.StatusBadRequest)
	after := wordbookDecode[wordbooks.Export](t, f.request(http.MethodGet, base+"/export", nil, f.reader, nil), http.StatusOK)
	if len(after.Entries) != 1 {
		t.Fatal("invalid import partially committed")
	}
	for _, invalidDirection := range []dictionary.Lang{"en_US", dictionary.Lang(strings.Repeat("a", 36)), "en\x00x"} {
		for _, from := range []bool{true, false} {
			invalidSnapshot := snapshot
			if from {
				invalidSnapshot.From = invalidDirection
			} else {
				invalidSnapshot.To = invalidDirection
			}
			invalidCapture := input
			invalidCapture.DictionaryEntries = &[]dictionary.Entry{invalidSnapshot}
			expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", invalidCapture, f.reader), http.StatusBadRequest)
			invalidEntry := export.Entries[0]
			invalidEntry.DictionaryEntries = []dictionary.Entry{invalidSnapshot}
			invalidImport := export
			invalidImport.Entries = []wordbooks.Entry{export.Entries[0], invalidEntry}
			expectShelfStatus(t, f.send(http.MethodPost, base+"/import", invalidImport, f.reader), http.StatusBadRequest)
		}
	}
	after = wordbookDecode[wordbooks.Export](t, f.request(http.MethodGet, base+"/export", nil, f.reader, nil), http.StatusOK)
	if len(after.Entries) != 1 {
		t.Fatal("invalid direction import partially committed")
	}
	t.Run("chronological round trip and timestamp validation", func(t *testing.T) {
		book := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]string{"name": "Chronology"}, f.reader), http.StatusCreated)
		path := fmt.Sprintf("/api/v1/wordbooks/%d", book.ID)
		chronology := export
		newer, older := e, e
		newer.Text, newer.CreatedAt, newer.UpdatedAt = "newer", "2025-01-02T00:00:00Z", "2025-01-03T00:00:00.123Z"
		older.Text, older.CreatedAt, older.UpdatedAt = "older", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"
		chronology.Entries = []wordbooks.Entry{newer, older}
		wordbookDecode[map[string]int](t, f.send(http.MethodPost, path+"/import", chronology, f.reader), http.StatusOK)
		roundTrip := wordbookDecode[wordbooks.Export](t, f.request(http.MethodGet, path+"/export", nil, f.reader, nil), http.StatusOK)
		if len(roundTrip.Entries) != 2 || roundTrip.Entries[0].CreatedAt != newer.CreatedAt || roundTrip.Entries[0].UpdatedAt != newer.UpdatedAt ||
			roundTrip.Entries[1].CreatedAt != older.CreatedAt || roundTrip.Entries[1].UpdatedAt != older.UpdatedAt ||
			roundTrip.Entries[0].CreatedAt <= roundTrip.Entries[1].CreatedAt {
			t.Fatalf("newest-first import lost chronological order: %+v", roundTrip.Entries)
		}
		for _, dates := range [][2]string{
			{"malformed", newer.UpdatedAt},
			{"2025-01-02T00:00:00+00:00", newer.UpdatedAt},
			{"2025-01-02T00:00:00.000Z", newer.UpdatedAt},
			{newer.CreatedAt, "malformed"},
			{newer.CreatedAt, older.CreatedAt},
		} {
			invalidEntry := newer
			invalidEntry.CreatedAt, invalidEntry.UpdatedAt = dates[0], dates[1]
			chronology.Entries = []wordbooks.Entry{older, invalidEntry}
			expectShelfStatus(t, f.send(http.MethodPost, path+"/import", chronology, f.reader), http.StatusBadRequest)
		}
		unchanged := wordbookDecode[wordbooks.Export](t, f.request(http.MethodGet, path+"/export", nil, f.reader, nil), http.StatusOK)
		if len(unchanged.Entries) != 2 {
			t.Fatal("invalid timestamps partially committed")
		}
		manual := newer
		manual.CreatedAt, manual.UpdatedAt = "", ""
		manualJSON, err := json.Marshal(manual)
		if err != nil {
			t.Fatal(err)
		}
		var omitted map[string]any
		if err := json.Unmarshal(manualJSON, &omitted); err != nil {
			t.Fatal(err)
		}
		delete(omitted, "created_at")
		delete(omitted, "updated_at")
		before := time.Now().UTC()
		wordbookDecode[map[string]int](t, f.send(http.MethodPost, path+"/import", map[string]any{
			"version": 1, "wordbook": chronology.Wordbook, "entries": []any{manual, omitted},
		}, f.reader), http.StatusOK)
		withManual := wordbookDecode[wordbooks.Export](t, f.request(http.MethodGet, path+"/export", nil, f.reader, nil), http.StatusOK)
		if len(withManual.Entries) != 4 {
			t.Fatal("manual imports missing")
		}
		for _, entry := range withManual.Entries[2:] {
			created, err := time.Parse(time.RFC3339Nano, entry.CreatedAt)
			if err != nil || created.Before(before) || entry.CreatedAt != entry.UpdatedAt {
				t.Fatalf("blank/omitted timestamps did not use server time: %+v", entry)
			}
		}
	})
	bad = export
	bad.Version = 2
	expectShelfStatus(t, f.send(http.MethodPost, base+"/import", bad, f.reader), http.StatusBadRequest)
	bad = export
	bad.Entries = make([]wordbooks.Entry, wordbooks.MaxImportEntries+1)
	expectShelfStatus(t, f.send(http.MethodPost, base+"/import", bad, f.reader), http.StatusBadRequest)
	expectShelfStatus(t, f.send(http.MethodPatch, base, map[string]bool{"archived": true}, f.reader), http.StatusOK)
	expectShelfStatus(t, f.send(http.MethodPost, base+"/import", export, f.reader), http.StatusBadRequest)
	for _, body := range []string{
		`null`, `{} trailing`, `{"name":null}`, `{"name":" "}`, `{"name":"ok","extra":true}`,
	} {
		expectShelfStatus(t, f.request(http.MethodPost, "/api/v1/wordbooks", strings.NewReader(body), f.reader, nil), http.StatusBadRequest)
	}
	for _, body := range []string{
		`{"kind":"word","text":"Cats"}`,
		`{"wordbook_id":0,"kind":"word","text":"Cats","source":{"book_id":null,"book_file_id":null,"book_title":"","locator":{},"fraction":0}}`,
		`{"kind":"word","text":"","source":{"book_id":null,"book_file_id":null,"book_title":"","locator":{},"fraction":0}}`,
		`{"kind":"word","text":"Cats","source":{"book_id":null,"book_file_id":1,"book_title":"","locator":{},"fraction":0}}`,
		`{"kind":"word","text":"Cats","source":{"book_id":null,"book_file_id":null,"book_title":"","locator":null,"fraction":0}}`,
		`{"kind":"word","text":"Cats","source":{"book_id":null,"book_file_id":null,"book_title":"","locator":{},"fraction":1.1}}`,
		`{"kind":"word","text":"Cats","source":{"book_id":null,"book_file_id":null,"book_title":"","locator":{},"fraction":null}}`,
		`{"kind":"word","text":"Cats","source":{"book_id":null,"book_file_id":null,"book_title":"","locator":{},"fraction":0,"chapter":null}}`,
		`{"kind":"sentence","text":"Cats","definition":"not allowed","source":{"book_id":null,"book_file_id":null,"book_title":"","locator":{},"fraction":0}}`,
	} {
		expectShelfStatus(t, f.request(http.MethodPost, "/api/v1/wordbooks/entries", strings.NewReader(body), f.reader, nil), http.StatusBadRequest)
	}
	tooLong := wordbookCapture("passage")
	tooLong.Text = strings.Repeat("x", 100001)
	expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", tooLong, f.reader), http.StatusBadRequest)
}
