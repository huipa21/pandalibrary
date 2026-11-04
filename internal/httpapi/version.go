package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"pandalibrary/internal/buildinfo"

	"github.com/go-chi/chi/v5"
)

// VersionMount registers public, read-only build provenance.
func VersionMount(logger *slog.Logger) Mount {
	info, err := buildinfo.Current()
	if err != nil {
		logger.Warn("build version is unavailable", "error", err)
	}
	return versionMount(info, err, logger)
}

func versionMount(info buildinfo.Info, infoErr error, logger *slog.Logger) Mount {
	return func(router chi.Router, _ Middleware) {
		router.Get("/api/v1/version", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			if infoErr != nil {
				WriteProblem(w, logger, http.StatusServiceUnavailable, "Build version is unavailable.")
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			if err := json.NewEncoder(w).Encode(info); err != nil {
				logger.Error("write version response", "error", err)
			}
		})
	}
}
