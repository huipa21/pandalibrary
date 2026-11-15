package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"unicode/utf8"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/wordbooks"

	"github.com/go-chi/chi/v5"
)

type wordbookHTTP struct {
	*catalogHTTP
	wordbooks *wordbooks.Service
}

func WordbookMount(service *wordbooks.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	h := &wordbookHTTP{catalogHTTP: &catalogHTTP{logger: logger}, wordbooks: service}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/wordbooks", h.withViewer(h.list))
			secured.Get("/api/v1/wordbooks/{id}/entries", h.withViewer(h.entries))
			secured.Get("/api/v1/wordbooks/{id}/export", h.withViewer(h.export))
			secured.With(cookieProtection).Post("/api/v1/wordbooks", h.withViewer(h.create))
			secured.With(cookieProtection).Patch("/api/v1/wordbooks/{id}", h.withViewer(h.patchBook))
			secured.With(cookieProtection).Post("/api/v1/wordbooks/entries", h.withViewer(h.capture))
			secured.With(cookieProtection).Patch("/api/v1/wordbooks/{id}/entries/{entryID}", h.withViewer(h.patchEntry))
			secured.With(cookieProtection).Delete("/api/v1/wordbooks/{id}/entries/{entryID}", h.withViewer(h.deleteEntry))
			secured.With(cookieProtection).Post("/api/v1/wordbooks/{id}/import", h.withViewer(h.importEntries))
		})
	}
}

// Decode separately from catalog's smaller body cap so bounded snapshot imports fit.
func (h *wordbookHTTP) decode(w http.ResponseWriter, r *http.Request, target any, limit int64) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		h.writeDecodeError(w, err)
		return false
	}
	if !utf8.Valid(raw) {
		h.writeDecodeError(w, nil)
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		h.writeDecodeError(w, err)
		return false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		h.writeDecodeError(w, err)
		return false
	}
	for _, value := range fields {
		if string(value) == "null" {
			h.writeDecodeError(w, nil)
			return false
		}
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		h.writeDecodeError(w, err)
		return false
	}
	return true
}

func (h *wordbookHTTP) respond(w http.ResponseWriter, r *http.Request, status int, value any, err error) {
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, status, value)
}

func (h *wordbookHTTP) list(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	if _, ok := h.query(w, r); !ok {
		return
	}
	result, err := h.wordbooks.List(r.Context(), viewer.UserID)
	h.respond(w, r, http.StatusOK, map[string]any{"wordbooks": result}, err)
}

func (h *wordbookHTTP) create(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	var input struct {
		Name string `json:"name"`
	}
	if !h.decode(w, r, &input, 1<<20) {
		return
	}
	result, err := h.wordbooks.Create(r.Context(), viewer.UserID, input.Name)
	h.respond(w, r, http.StatusCreated, result, err)
}

func (h *wordbookHTTP) patchBook(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	var input wordbooks.BookPatch
	if !h.decode(w, r, &input, 1<<20) {
		return
	}
	result, err := h.wordbooks.PatchBook(r.Context(), viewer.UserID, id, input)
	h.respond(w, r, http.StatusOK, result, err)
}

func (h *wordbookHTTP) entries(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	if _, ok := h.query(w, r); !ok {
		return
	}
	result, err := h.wordbooks.Export(r.Context(), viewer.UserID, id)
	h.respond(w, r, http.StatusOK, map[string]any{"entries": result.Entries}, err)
}

func (h *wordbookHTTP) export(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	if _, ok := h.query(w, r); !ok {
		return
	}
	result, err := h.wordbooks.Export(r.Context(), viewer.UserID, id)
	h.respond(w, r, http.StatusOK, result, err)
}

func (h *wordbookHTTP) capture(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	var input wordbooks.Capture
	if !h.decode(w, r, &input, 1<<20) {
		return
	}
	result, err := h.wordbooks.Capture(r.Context(), viewer, input)
	h.respond(w, r, http.StatusCreated, result, err)
}

func (h *wordbookHTTP) patchEntry(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	entryID, ok := h.pathID(w, r, "entryID")
	if !ok {
		return
	}
	var input wordbooks.EntryPatch
	if !h.decode(w, r, &input, 1<<20) {
		return
	}
	result, err := h.wordbooks.PatchEntry(r.Context(), viewer.UserID, id, entryID, input)
	h.respond(w, r, http.StatusOK, result, err)
}

func (h *wordbookHTTP) deleteEntry(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	entryID, ok := h.pathID(w, r, "entryID")
	if !ok {
		return
	}
	if err := h.wordbooks.DeleteEntry(r.Context(), viewer.UserID, id, entryID); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (h *wordbookHTTP) importEntries(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	var input wordbooks.Export
	if !h.decode(w, r, &input, 16<<20) {
		return
	}
	count, err := h.wordbooks.Import(r.Context(), viewer.UserID, id, input)
	h.respond(w, r, http.StatusOK, map[string]int{"imported": count}, err)
}
