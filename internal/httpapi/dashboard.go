package httpapi

import (
	"log/slog"
	"net/http"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/catalog"

	"github.com/go-chi/chi/v5"
)

// DashboardMount registers session-authenticated dashboard routes.
func DashboardMount(service *catalog.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &catalogHTTP{service: service, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/dashboard/sections/{section}/books", handler.withViewer(handler.listDashboardBooks))
		})
	}
}

func (h *catalogHTTP) listDashboardBooks(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	section := chi.URLParam(r, "section")
	if section == "" {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The dashboard section is required.")
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

	result, err := h.service.ListDashboardBooks(r.Context(), viewer, section, options)
	if err != nil {
		h.writeError(w, r, err)
		return
	}

	h.writeJSON(w, http.StatusOK, result)
}
