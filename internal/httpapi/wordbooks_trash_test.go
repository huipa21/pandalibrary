package httpapi

import (
	"fmt"
	"net/http"
	"testing"

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
