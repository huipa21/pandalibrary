package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/catalog"

	"github.com/go-chi/chi/v5"
)

// ShelfMount registers session-authenticated shelf routes.
func ShelfMount(service *catalog.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &catalogHTTP{service: service, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/shelves", handler.withViewer(handler.listShelves))
			secured.With(cookieProtection).Post("/api/v1/shelves", handler.withViewer(handler.createShelf))
			secured.Get("/api/v1/shelves/{id}", handler.withViewer(handler.getShelf))
			secured.With(cookieProtection).Patch("/api/v1/shelves/{id}", handler.withViewer(handler.updateShelf))
			secured.With(cookieProtection).Delete("/api/v1/shelves/{id}", handler.withViewer(handler.deleteShelf))
			secured.Get("/api/v1/shelves/{id}/books", handler.withViewer(handler.listShelfBooks))
			secured.With(cookieProtection).Put("/api/v1/shelves/{id}/books/{bookID}", handler.withViewer(handler.putShelfBook))
			secured.With(cookieProtection).Delete("/api/v1/shelves/{id}/books/{bookID}", handler.withViewer(handler.removeShelfBook))
		})
	}
}

func (h *catalogHTTP) listShelves(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	values, ok := h.query(w, r, "limit", "cursor")
	if !ok {
		return
	}
	options, ok := h.pageOptions(w, values)
	if !ok {
		return
	}
	result, err := h.service.ListShelves(r.Context(), viewer, options)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *catalogHTTP) getShelf(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	if _, ok := h.query(w, r); !ok {
		return
	}
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	result, err := h.service.GetShelf(r.Context(), viewer, id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]catalog.Shelf{"shelf": result})
}

func (h *catalogHTTP) createShelf(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	if _, ok := h.query(w, r); !ok {
		return
	}
	var request catalog.ShelfInput
	if !h.decodeJSON(w, r, &request) {
		return
	}
	result, err := h.service.CreateShelf(r.Context(), viewer, request)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, map[string]catalog.Shelf{"shelf": result})
}

func (h *catalogHTTP) updateShelf(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	if _, ok := h.query(w, r); !ok {
		return
	}
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	var request catalog.ShelfPatch
	if !h.decodeJSON(w, r, &request) {
		return
	}
	result, err := h.service.UpdateShelf(r.Context(), viewer, id, request)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]catalog.Shelf{"shelf": result})
}

func (h *catalogHTTP) deleteShelf(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	if _, ok := h.query(w, r); !ok {
		return
	}
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	if err := h.service.DeleteShelf(r.Context(), viewer, id); err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (h *catalogHTTP) listShelfBooks(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	values, ok := h.query(w, r, "limit", "cursor")
	if !ok {
		return
	}
	options, ok := h.pageOptions(w, values)
	if !ok {
		return
	}
	result, err := h.service.ListShelfBooks(r.Context(), viewer, id, options)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *catalogHTTP) shelfBookIDs(w http.ResponseWriter, r *http.Request) (int64, int64, bool) {
	if _, ok := h.query(w, r); !ok {
		return 0, 0, false
	}
	shelfID, ok := h.pathID(w, r, "id")
	if !ok {
		return 0, 0, false
	}
	bookID, ok := h.pathID(w, r, "bookID")
	return shelfID, bookID, ok
}

func (h *catalogHTTP) shelfBookPosition(w http.ResponseWriter, r *http.Request) (*int64, bool) {
	reader := http.MaxBytesReader(w, r.Body, maxCatalogJSONBytes)
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	var request *struct {
		Position catalog.Optional[int64] `json:"position"`
	}
	if err := decoder.Decode(&request); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, true
		}
		h.writeDecodeError(w, err)
		return nil, false
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		h.writeDecodeError(w, err)
		return nil, false
	}
	if request == nil || request.Position.Set && request.Position.Value == nil {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The shelf book position is invalid.")
		return nil, false
	}
	return request.Position.Value, true
}

func (h *catalogHTTP) putShelfBook(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	shelfID, bookID, ok := h.shelfBookIDs(w, r)
	if !ok {
		return
	}
	position, ok := h.shelfBookPosition(w, r)
	if !ok {
		return
	}
	if err := h.service.PutShelfBook(r.Context(), viewer, shelfID, bookID, position); err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

func (h *catalogHTTP) removeShelfBook(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	shelfID, bookID, ok := h.shelfBookIDs(w, r)
	if !ok {
		return
	}
	if err := h.service.RemoveShelfBook(r.Context(), viewer, shelfID, bookID); err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]bool{"removed": true})
}
