package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/covers"
	"pandalibrary/internal/metadata"

	"github.com/go-chi/chi/v5"
)

type metadataHTTP struct {
	service *metadata.Service
	common  *catalogHTTP
}

// MetadataMount registers administrator-only configuration and explicit merge routes.
func MetadataMount(service *metadata.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	h := &metadataHTTP{service: service, common: &catalogHTTP{logger: logger}}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(admin chi.Router) {
			admin.Use(SessionMiddleware(authentication, logger))
			admin.Use(RequireRole("admin", logger))
			admin.Get("/api/v1/admin/metadata/providers", h.common.withViewer(h.list))
			admin.With(cookieProtection).Patch("/api/v1/admin/metadata/providers/{provider}", h.common.withViewer(h.update))
			admin.With(cookieProtection).Post("/api/v1/books/{id}/metadata/candidates", h.common.withViewer(h.lookup))
			admin.With(cookieProtection).Post("/api/v1/books/{id}/metadata/apply", h.common.withViewer(h.apply))
			admin.With(cookieProtection).Post("/api/v1/books/{id}/metadata/cover", h.common.withViewer(h.cover))
		})
	}
}

func (h *metadataHTTP) list(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	result, err := h.service.ListProviders(r.Context(), viewer)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, map[string]any{"providers": result})
}

func (h *metadataHTTP) update(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	var patch metadata.ProviderPatch
	if !h.common.decodeJSON(w, r, &patch) {
		return
	}
	result, err := h.service.UpdateProvider(r.Context(), viewer, chi.URLParam(r, "provider"), patch)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, map[string]metadata.ProviderSettings{"provider": result})
}

func (h *metadataHTTP) lookup(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.common.pathID(w, r, "id")
	if !ok {
		return
	}
	// No caller-controlled query or API destination is accepted.
	if r.ContentLength != 0 || r.URL.RawQuery != "" {
		WriteProblem(w, h.common.logger, http.StatusBadRequest, "Candidate lookup uses the catalog book, not request parameters.")
		return
	}
	result, err := h.service.Lookup(r.Context(), viewer, id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, result)
}

func (h *metadataHTTP) apply(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.common.pathID(w, r, "id")
	if !ok {
		return
	}
	var request metadata.ApplyRequest
	if !h.common.decodeJSON(w, r, &request) {
		return
	}
	result, err := h.service.Apply(r.Context(), viewer, id, request)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, map[string]catalog.Book{"book": result})
}

func (h *metadataHTTP) cover(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.common.pathID(w, r, "id")
	if !ok {
		return
	}
	var request metadata.CoverRequest
	if !h.common.decodeJSON(w, r, &request) {
		return
	}
	result, err := h.service.Cover(r.Context(), viewer, id, request)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	if _, err := w.Write(result.FullJPEG); err != nil {
		h.common.logger.Error("write metadata cover response", "error", err)
	}
}

func (h *metadataHTTP) writeError(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case errors.Is(err, metadata.ErrInvalid), errors.Is(err, covers.ErrInvalidImage):
		WriteProblem(w, h.common.logger, http.StatusBadRequest, "The metadata request or provider cover is invalid.")
	case errors.Is(err, metadata.ErrNotFound):
		WriteProblem(w, h.common.logger, http.StatusNotFound, "")
	case errors.Is(err, metadata.ErrConflict):
		WriteProblem(w, h.common.logger, http.StatusConflict, "The candidate expired or changed. Look up candidates again.")
	case errors.Is(err, covers.ErrImageTooLarge):
		WriteProblem(w, h.common.logger, http.StatusRequestEntityTooLarge, "")
	default:
		// Metadata failures may involve credentials; do not log raw upstream errors.
		if !errors.Is(err, catalog.ErrInvalid) && !errors.Is(err, catalog.ErrNotFound) &&
			!errors.Is(err, catalog.ErrForbidden) && !errors.Is(err, catalog.ErrTooLarge) {
			h.common.logger.Error("metadata request failed", "request_id", RequestID(r))
			WriteProblem(w, h.common.logger, http.StatusBadGateway, "The metadata operation failed.")
			return
		}
		h.common.writeError(w, r, err)
	}
}
