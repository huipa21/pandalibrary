package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/stats"

	"github.com/go-chi/chi/v5"
)

// StatsMount registers the authenticated, read-only dashboard endpoint.
func StatsMount(service *stats.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &statsHTTP{service: service, logger: logger}
	return func(router chi.Router, _ Middleware) {
		router.With(SessionMiddleware(authentication, logger)).Get("/api/v1/stats", handler.get)
	}
}

type statsHTTP struct {
	service *stats.Service
	logger  *slog.Logger
}

func (h *statsHTTP) get(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := ViewerFromRequest(r)
	if !ok {
		WriteProblem(w, h.logger, http.StatusUnauthorized, "")
		return
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(values) != 3 {
		WriteProblem(w, h.logger, http.StatusBadRequest, "Exactly one from, to, and timezone parameter is required.")
		return
	}
	for _, key := range []string{"from", "to", "timezone"} {
		if len(values[key]) != 1 || values[key][0] == "" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Exactly one from, to, and timezone parameter is required.")
			return
		}
	}
	result, err := h.service.Get(r.Context(), stats.Viewer{
		UserID: user.ID, IsAdmin: user.Role == "admin",
	}, values.Get("from"), values.Get("to"), values.Get("timezone"))
	if err != nil {
		if errors.Is(err, stats.ErrInvalid) {
			WriteProblem(w, h.logger, http.StatusBadRequest, strings.TrimPrefix(err.Error(), "invalid stats request: "))
		} else {
			h.logger.Error("stats request failed", "request_id", RequestID(r), "error", err)
			WriteProblem(w, h.logger, http.StatusInternalServerError, "")
		}
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		h.logger.Error("write stats response", "error", err)
	}
}
