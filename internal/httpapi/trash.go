package httpapi

import (
	"log/slog"
	"net/http"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/trash"

	"github.com/go-chi/chi/v5"
)

type trashHTTP struct {
	*catalogHTTP
	trash *trash.Service
}

func TrashMount(service *trash.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	h := &trashHTTP{catalogHTTP: &catalogHTTP{logger: logger}, trash: service}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/trash", h.withViewer(h.list))
			secured.With(cookieProtection).Post("/api/v1/trash/restore", h.withViewer(h.apply(true)))
			secured.With(cookieProtection).Delete("/api/v1/trash", h.withViewer(h.apply(false)))
		})
	}
}

func (h *trashHTTP) list(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	values, ok := h.query(w, r, "type", "search")
	if !ok {
		return
	}
	items, err := h.trash.List(r.Context(), viewer, values.Get("type"), values.Get("search"))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, struct {
		Items []trash.Item `json:"items"`
	}{items})
}

func (h *trashHTTP) apply(restore bool) catalogHandler {
	return func(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
		var body struct {
			Items []trash.Ref `json:"items"`
		}
		if !h.decodeJSON(w, r, &body) {
			return
		}
		if err := h.trash.Apply(r.Context(), viewer, body.Items, restore); err != nil {
			h.writeError(w, r, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
	}
}
