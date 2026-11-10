package httpapi

import (
	"log/slog"
	"net/http"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/catalog"

	"github.com/go-chi/chi/v5"
)

func ReviewMount(service *catalog.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	h := &catalogHTTP{service: service, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/books/{id}/reviews", h.withViewer(h.listReviews))
			secured.Get("/api/v1/me/notes", h.withViewer(h.listPersonalActivity))
			secured.With(cookieProtection).Put("/api/v1/books/{id}/reviews/me", h.withViewer(h.saveMyReview))
			secured.With(cookieProtection).Delete("/api/v1/books/{id}/reviews/me", h.withViewer(h.deleteMyReview))
			secured.With(cookieProtection).Delete("/api/v1/books/{id}/reviews/{reviewId}", h.withViewer(h.deleteReview))
		})
	}
}

func (h *catalogHTTP) listPersonalActivity(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	values, ok := h.query(w, r, "limit", "cursor")
	if !ok {
		return
	}
	options, ok := h.pageOptions(w, values)
	if !ok {
		return
	}
	result, err := h.service.ListPersonalActivity(r.Context(), viewer, options)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	h.writeJSON(w, http.StatusOK, result)
}

func (h *catalogHTTP) listReviews(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
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
	result, err := h.service.ListReviews(r.Context(), viewer, id, options)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *catalogHTTP) saveMyReview(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	var request struct {
		Body string `json:"body"`
	}
	if !h.decodeJSON(w, r, &request) {
		return
	}
	result, err := h.service.SaveMyReview(r.Context(), viewer, id, request.Body)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]catalog.Review{"review": result})
}

func (h *catalogHTTP) deleteMyReview(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	if err := h.service.DeleteMyReview(r.Context(), viewer, id); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (h *catalogHTTP) deleteReview(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	reviewID, ok := h.pathID(w, r, "reviewId")
	if !ok {
		return
	}
	if err := h.service.DeleteReview(r.Context(), viewer, id, reviewID); err != nil {
		h.writeError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
