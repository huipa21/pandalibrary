package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/jobs"

	"github.com/go-chi/chi/v5"
)

type maintenanceHTTP struct {
	service *jobs.Maintenance
	logger  *slog.Logger
}

// MaintenanceMount registers administrator-only maintenance status and run routes.
func MaintenanceMount(service *jobs.Maintenance, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &maintenanceHTTP{service: service, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(admin chi.Router) {
			admin.Use(SessionMiddleware(authentication, logger))
			admin.Use(RequireRole("admin", logger))
			admin.Get("/api/v1/admin/maintenance", handler.list)
			admin.With(cookieProtection).Post("/api/v1/admin/maintenance/{job}", handler.run)
		})
	}
}

func (h *maintenanceHTTP) list(w http.ResponseWriter, _ *http.Request) {
	h.writeJSON(w, http.StatusOK, map[string]any{"jobs": h.service.Jobs()})
}

func (h *maintenanceHTTP) run(w http.ResponseWriter, r *http.Request) {
	run, err := h.service.RunNow(chi.URLParam(r, "job"))
	switch {
	case errors.Is(err, jobs.ErrUnknownJob):
		WriteProblem(w, h.logger, http.StatusNotFound, "The maintenance job is not supported.")
	case errors.Is(err, jobs.ErrJobRunning):
		WriteProblem(w, h.logger, http.StatusConflict, "This maintenance job is already running.")
	case errors.Is(err, jobs.ErrJobStopped):
		WriteProblem(w, h.logger, http.StatusServiceUnavailable, "")
	case err != nil:
		h.logger.Error("accept maintenance run", "request_id", RequestID(r), "error", err)
		WriteProblem(w, h.logger, http.StatusInternalServerError, "")
	default:
		h.writeJSON(w, http.StatusAccepted, map[string]jobs.RunStatus{"run": run})
	}
}

func (h *maintenanceHTTP) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		h.logger.Error("write maintenance response", "error", err)
	}
}
