package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/bookheap"
	"pandalibrary/internal/catalog"
)

// BookheapAssignMount exposes bulk assignment of heap items to a library and shelves.
func BookheapAssignMount(service *bookheap.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &bookheapHTTP{service: service, catalog: &catalogHTTP{logger: logger}}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(admin chi.Router) {
			admin.Use(SessionMiddleware(authentication, logger))
			admin.Use(RequireRole("admin", logger))
			admin.With(cookieProtection).Post("/api/v1/admin/bookheap/assign", handler.catalog.withViewer(handler.assign))
		})
	}
}

func (h *bookheapHTTP) assign(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	var body struct {
		IDs       []int64 `json:"ids"`
		LibraryID int64   `json:"library_id"`
		ShelfIDs  []int64 `json:"shelf_ids"`
	}
	if !h.catalog.decodeJSON(w, r, &body) {
		return
	}
	results, err := h.service.Assign(r.Context(), viewer, body.IDs, body.LibraryID, body.ShelfIDs)
	var shelf *bookheap.ShelfError
	if errors.As(err, &shelf) {
		w.Header().Set("Cache-Control", "no-store")
		status, detail := http.StatusBadRequest, "The shelf cannot receive assigned books."
		switch {
		case errors.Is(err, catalog.ErrNotFound):
			status, detail = http.StatusNotFound, "The shelf was not found."
		case errors.Is(err, catalog.ErrForbidden):
			detail = "You cannot add books to this shelf."
		case errors.Is(err, catalog.ErrConflict):
			detail = "Automatic shelves cannot receive assigned books."
		}
		WriteProblemWith(w, h.catalog.logger, status, detail, map[string]any{"shelf_id": shelf.ShelfID})
		return
	}
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.catalog.writeJSON(w, http.StatusAccepted, map[string][]bookheap.AssignResult{"results": results})
}
