package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"pandalibrary/internal/dictionary"
	"pandalibrary/internal/trash"
	"pandalibrary/internal/wordbooks"
)

func TestWordbookTrashPreservesEntries(t *testing.T) {
	f := newWordbookFixture(t)
	defaultID := f.defaultID(t)
	expectShelfStatus(t, f.request(http.MethodDelete, fmt.Sprintf("/api/v1/wordbooks/%d", defaultID), nil, f.reader, nil), http.StatusConflict)
	book := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Recover"}, f.reader), http.StatusCreated)
	capture := wordbookCapture("word")
	capture.WordbookID = &book.ID
	entry := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", capture, f.reader), http.StatusCreated)
	ref := trash.Ref{Type: "wordbook", ID: fmt.Sprint(book.ID)}
	bookPath := fmt.Sprintf("/api/v1/wordbooks/%d", book.ID)
	expectShelfStatus(t, f.request(http.MethodDelete, bookPath, nil, f.other, nil), http.StatusNotFound)
	expectShelfStatus(t, f.request(http.MethodDelete, bookPath, nil, f.reader, nil), http.StatusNoContent)
	expectShelfStatus(t, f.request(http.MethodGet, bookPath+"/entries", nil, f.reader, nil), http.StatusNotFound)
	expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/trash/restore", map[string]any{"items": []trash.Ref{ref}}, f.reader), http.StatusNoContent)
	result := wordbookDecode[struct {
		Entries []wordbooks.Entry `json:"entries"`
	}](t, f.request(http.MethodGet, bookPath+"/entries", nil, f.reader, nil), http.StatusOK)
	if len(result.Entries) != 1 || result.Entries[0].ID != entry.ID {
		t.Fatalf("restored entries: %+v", result.Entries)
	}
}

func TestWordbookMeaningLanguage(t *testing.T) {
	f := newWordbookFixture(t)
	book := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Study", "meaning_language": " zh-Hans "}, f.reader), http.StatusCreated)
	if book.MeaningLanguage != "zh-Hans" {
		t.Fatalf("create: %+v", book)
	}
	path := fmt.Sprintf("/api/v1/wordbooks/%d", book.ID)
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, path, map[string]any{"name": "Renamed"}, f.reader), http.StatusOK)
	list := wordbookDecode[struct {
		Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
	}](t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil), http.StatusOK)
	if book.MeaningLanguage != "zh-Hans" || list.Wordbooks[1].MeaningLanguage != "zh-Hans" {
		t.Fatalf("settings lost: %+v %+v", book, list.Wordbooks)
	}
	for _, invalid := range []any{nil, 1, "en_US", "a", strings.Repeat("a", 36), "en\x00x"} {
		expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Bad", "meaning_language": invalid}, f.reader), http.StatusBadRequest)
		expectShelfStatus(t, f.send(http.MethodPatch, path, map[string]any{"meaning_language": invalid}, f.reader), http.StatusBadRequest)
	}
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, path, map[string]any{"meaning_language": "ja"}, f.reader), http.StatusOK)
	if book.MeaningLanguage != "ja" {
		t.Fatalf("patch: %+v", book)
	}
	book = wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, path, map[string]any{"meaning_language": ""}, f.reader), http.StatusOK)
	if book.MeaningLanguage != "" {
		t.Fatalf("clear: %+v", book)
	}
}

func TestWordbookDeleteDefaultAndRestore(t *testing.T) {
	f := newWordbookFixture(t)
	id := f.defaultID(t)
	path := fmt.Sprintf("/api/v1/wordbooks/%d", id)
	expectShelfStatus(t, f.request(http.MethodDelete, path, nil, f.reader, nil), http.StatusConflict)
	other := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Other"}, f.reader), http.StatusCreated)
	otherPath := fmt.Sprintf("/api/v1/wordbooks/%d", other.ID)
	wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, otherPath, map[string]any{"archived": true}, f.reader), http.StatusOK)
	capture := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", wordbookCapture("word"), f.reader), http.StatusCreated)
	expectShelfStatus(t, f.request(http.MethodDelete, path, nil, f.reader, nil), http.StatusNoContent)
	if got := f.defaultID(t); got != other.ID {
		t.Fatalf("default = %d, want %d", got, other.ID)
	}
	list := wordbookDecode[struct {
		Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
	}](t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil), http.StatusOK)
	if list.Wordbooks[0].Archived {
		t.Fatal("replacement default is archived")
	}
	expectShelfStatus(t, f.request(http.MethodDelete, otherPath, nil, f.reader, nil), http.StatusConflict)
	expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/trash/restore", map[string]any{"items": []trash.Ref{{Type: "wordbook", ID: fmt.Sprint(id)}}}, f.reader), http.StatusNoContent)
	list = wordbookDecode[struct {
		Wordbooks []wordbooks.Wordbook `json:"wordbooks"`
	}](t, f.request(http.MethodGet, "/api/v1/wordbooks", nil, f.reader, nil), http.StatusOK)
	if len(list.Wordbooks) != 2 || list.Wordbooks[0].ID != other.ID || list.Wordbooks[1].IsDefault {
		t.Fatalf("restored default state: %+v", list.Wordbooks)
	}
	entries := wordbookDecode[struct {
		Entries []wordbooks.Entry `json:"entries"`
	}](t, f.request(http.MethodGet, path+"/entries", nil, f.reader, nil), http.StatusOK)
	if len(entries.Entries) != 1 || entries.Entries[0].ID != capture.ID {
		t.Fatalf("restored entries: %+v", entries.Entries)
	}
}

func TestWordbookMergePreservesEntries(t *testing.T) {
	f := newWordbookFixture(t)
	id := f.defaultID(t)
	wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Earlier"}, f.reader), http.StatusCreated)
	target := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Target"}, f.reader), http.StatusCreated)
	snapshots := []dictionary.Entry{{Source: "old", SourceName: "Old", Headword: "cat", Definitions: []string{"cat"}, Match: dictionary.MatchExact},
		{Source: "new", SourceName: "New", Headword: "cat", Definitions: []string{"猫"}, Match: dictionary.MatchExact, From: dictionary.English, To: dictionary.Chinese}}
	input := wordbookCapture("word")
	input.DictionaryEntries = &snapshots
	entry := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusCreated)
	input.WordbookID = &target.ID
	existing := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", input, f.reader), http.StatusCreated)
	path := fmt.Sprintf("/api/v1/wordbooks/%d", id)
	expectShelfStatus(t, f.send(http.MethodDelete, path, map[string]any{"merge_into_id": target.ID}, f.reader), http.StatusNoContent)
	if got := f.defaultID(t); got != target.ID {
		t.Fatalf("default = %d", got)
	}
	entries := wordbookDecode[struct {
		Entries []wordbooks.Entry `json:"entries"`
	}](t, f.request(http.MethodGet, fmt.Sprintf("/api/v1/wordbooks/%d/entries", target.ID), nil, f.reader, nil), http.StatusOK)
	entry.WordbookID = target.ID
	if len(entries.Entries) != 2 || !reflect.DeepEqual(entries.Entries[0], entry) || !reflect.DeepEqual(entries.Entries[1], existing) {
		t.Fatalf("merge lost data: got %+v want %+v", entries.Entries, entry)
	}
	expectShelfStatus(t, f.send(http.MethodPost, "/api/v1/trash/restore", map[string]any{"items": []trash.Ref{{Type: "wordbook", ID: fmt.Sprint(id)}}}, f.reader), http.StatusNoContent)
	old := wordbookDecode[struct {
		Entries []wordbooks.Entry `json:"entries"`
	}](t, f.request(http.MethodGet, path+"/entries", nil, f.reader, nil), http.StatusOK)
	if len(old.Entries) != 0 {
		t.Fatalf("restored merged source contains entries: %+v", old)
	}
}

func TestWordbookMergeInvalidTargets(t *testing.T) {
	f := newWordbookFixture(t)
	id := f.defaultID(t)
	target := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Target"}, f.reader), http.StatusCreated)
	foreign := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Private"}, f.other), http.StatusCreated)
	archived := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Archived"}, f.reader), http.StatusCreated)
	deleted := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Deleted"}, f.reader), http.StatusCreated)
	expectShelfStatus(t, f.request(http.MethodDelete, fmt.Sprintf("/api/v1/wordbooks/%d", deleted.ID), nil, f.reader, nil), http.StatusNoContent)
	wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPatch, fmt.Sprintf("/api/v1/wordbooks/%d", archived.ID), map[string]any{"archived": true}, f.reader), http.StatusOK)
	entry := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", wordbookCapture("word"), f.reader), http.StatusCreated)
	path := fmt.Sprintf("/api/v1/wordbooks/%d", id)
	for _, tc := range []struct {
		body   any
		status int
	}{
		{map[string]any{"merge_into_id": id}, http.StatusBadRequest},
		{map[string]any{"merge_into_id": 0}, http.StatusBadRequest},
		{map[string]any{"merge_into_id": foreign.ID}, http.StatusNotFound},
		{map[string]any{"merge_into_id": 999999}, http.StatusNotFound},
		{map[string]any{"merge_into_id": archived.ID}, http.StatusBadRequest},
		{map[string]any{"merge_into_id": deleted.ID}, http.StatusNotFound},
		{map[string]any{"merge_into_id": nil}, http.StatusBadRequest},
		{map[string]any{"unknown": 1}, http.StatusBadRequest},
	} {
		expectShelfStatus(t, f.send(http.MethodDelete, path, tc.body, f.reader), tc.status)
	}

	_, err := f.db.Writer.Exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < ?) INSERT INTO wordbook_entries(wordbook_id,kind,text,dictionary_entries,source,created_at,updated_at) SELECT ?, 'word', 'x', '[]', '{}', 'now', 'now' FROM n`, wordbooks.MaxEntries, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	expectShelfStatus(t, f.send(http.MethodDelete, path, map[string]any{"merge_into_id": target.ID}, f.reader), http.StatusBadRequest)
	if got := f.defaultID(t); got != id {
		t.Fatalf("failed merge changed default: %d", got)
	}
	entries := wordbookDecode[struct {
		Entries []wordbooks.Entry `json:"entries"`
	}](t, f.request(http.MethodGet, path+"/entries", nil, f.reader, nil), http.StatusOK)
	if len(entries.Entries) != 1 || entries.Entries[0].ID != entry.ID {
		raw, _ := json.Marshal(entries)
		t.Fatalf("failed merge changed source: %s", raw)
	}
}

func TestWordbookMergeRollsBackOnDeleteFailure(t *testing.T) {
	f := newWordbookFixture(t)
	id := f.defaultID(t)
	target := wordbookDecode[wordbooks.Wordbook](t, f.send(http.MethodPost, "/api/v1/wordbooks", map[string]any{"name": "Target"}, f.reader), http.StatusCreated)
	entry := wordbookDecode[wordbooks.Entry](t, f.send(http.MethodPost, "/api/v1/wordbooks/entries", wordbookCapture("word"), f.reader), http.StatusCreated)
	if _, err := f.db.Writer.Exec(`CREATE TRIGGER reject_wordbook_trash BEFORE UPDATE OF deleted_at ON wordbooks BEGIN SELECT RAISE(ABORT, 'rejected'); END`); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/v1/wordbooks/%d", id)
	expectShelfStatus(t, f.send(http.MethodDelete, path, map[string]any{"merge_into_id": target.ID}, f.reader), http.StatusInternalServerError)
	if got := f.defaultID(t); got != id {
		t.Fatalf("default changed after rollback: %d", got)
	}
	entries := wordbookDecode[struct {
		Entries []wordbooks.Entry `json:"entries"`
	}](t, f.request(http.MethodGet, path+"/entries", nil, f.reader, nil), http.StatusOK)
	if len(entries.Entries) != 1 || entries.Entries[0].ID != entry.ID {
		t.Fatalf("entries changed after rollback: %+v", entries.Entries)
	}
}
