package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/dictionary"

	"github.com/go-chi/chi/v5"
)

// DictionaryService answers dictionary lookups and reports available dictionaries.
type DictionaryService interface {
	Lookup(ctx context.Context, query dictionary.Query) (dictionary.Result, error)
	Status(ctx context.Context) (dictionary.Status, error)
}

// DictionarySettingsService manages the online dictionary API address and key.
// Implementations return catalog.ErrForbidden for non-administrators, dictionary.ErrInvalid
// for rejected patches, dictionary.ErrNotConfigured when no address is set and
// dictionary.ErrUnavailable when the API cannot be reached.
type DictionarySettingsService interface {
	Settings(ctx context.Context, viewer catalog.Viewer) (dictionary.Settings, error)
	UpdateSettings(ctx context.Context, viewer catalog.Viewer, patch dictionary.SettingsPatch) (dictionary.Settings, error)
	TestConnection(ctx context.Context, viewer catalog.Viewer) (dictionary.Status, error)
}

type dictionaryHTTP struct {
	service  DictionaryService
	settings DictionarySettingsService
	common   *catalogHTTP
	logger   *slog.Logger
}

// DictionaryMount registers the authenticated dictionary lookup endpoints and the
// administrator-only online dictionary API settings endpoints.
func DictionaryMount(service DictionaryService, settings DictionarySettingsService, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &dictionaryHTTP{service: service, settings: settings, common: &catalogHTTP{logger: logger}, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/dictionary/status", handler.status)
			secured.Get("/api/v1/dictionary/lookup", handler.lookup)
		})
		router.Group(func(admin chi.Router) {
			admin.Use(SessionMiddleware(authentication, logger))
			admin.Use(RequireRole("admin", logger))
			admin.Get("/api/v1/admin/dictionary/settings", handler.common.withViewer(handler.getSettings))
			admin.With(cookieProtection).Patch("/api/v1/admin/dictionary/settings", handler.common.withViewer(handler.updateSettings))
			admin.With(cookieProtection).Post("/api/v1/admin/dictionary/test", handler.common.withViewer(handler.testConnection))
		})
	}
}

func (h *dictionaryHTTP) status(w http.ResponseWriter, r *http.Request) {
	if _, ok := ViewerFromRequest(r); !ok {
		h.logger.Error("dictionary route has no authenticated viewer", "request_id", RequestID(r))
		WriteProblem(w, h.logger, http.StatusUnauthorized, "")
		return
	}
	if r.URL.RawQuery != "" {
		WriteProblem(w, h.logger, http.StatusBadRequest, "A query parameter is invalid.")
		return
	}
	status, err := h.service.Status(r.Context())
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		if h.writeUnavailable(w, r, err) {
			return
		}
		h.logger.Error("dictionary status failed", "request_id", RequestID(r), "error", err)
		WriteProblem(w, h.logger, http.StatusInternalServerError, "")
		return
	}
	h.writeJSON(w, normalizeDictionaryStatus(status))
}

func normalizeDictionaryStatus(status dictionary.Status) dictionary.Status {
	if status.Directions == nil {
		status.Directions = []dictionary.Direction{}
	}
	for index := range status.Directions {
		if status.Directions[index].Sources == nil {
			status.Directions[index].Sources = []string{}
		}
	}
	if status.Sources == nil {
		status.Sources = []dictionary.SourceInfo{}
	}
	return status
}

func (h *dictionaryHTTP) lookup(w http.ResponseWriter, r *http.Request) {
	if _, ok := ViewerFromRequest(r); !ok {
		h.logger.Error("dictionary route has no authenticated viewer", "request_id", RequestID(r))
		WriteProblem(w, h.logger, http.StatusUnauthorized, "")
		return
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The query string is invalid.")
		return
	}
	for key, entries := range values {
		if (key != "q" && key != "from" && key != "to" && key != "limit") || len(entries) != 1 || entries[0] == "" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "A query parameter is invalid.")
			return
		}
	}
	if _, present := values["q"]; !present {
		WriteProblem(w, h.logger, http.StatusBadRequest, "A lookup text is required.")
		return
	}
	from, fromOK := dictionary.ParseLang(values.Get("from"))
	to, toOK := dictionary.ParseLang(values.Get("to"))
	if !fromOK || !toOK {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The source and target languages must be en, zh or ja.")
		return
	}
	query := dictionary.Query{Text: values.Get("q"), From: from, To: to}
	if value := values.Get("limit"); value != "" {
		query.Limit, err = strconv.Atoi(value)
		if err != nil || query.Limit < 1 || query.Limit > dictionary.MaxLimit {
			WriteProblem(w, h.logger, http.StatusBadRequest, "The limit must be between 1 and 50.")
			return
		}
	}
	result, err := h.service.Lookup(r.Context(), query)
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		if errors.Is(err, dictionary.ErrInvalid) {
			WriteProblem(w, h.logger, http.StatusBadRequest, strings.TrimPrefix(err.Error(), "invalid dictionary request: "))
		} else if !h.writeUnavailable(w, r, err) {
			h.logger.Error("dictionary lookup failed", "request_id", RequestID(r), "error", err)
			WriteProblem(w, h.logger, http.StatusInternalServerError, "")
		}
		return
	}
	if result.Entries == nil {
		result.Entries = []dictionary.Entry{}
	}
	for index := range result.Entries {
		if result.Entries[index].Definitions == nil {
			result.Entries[index].Definitions = []string{}
		}
	}
	h.writeJSON(w, result)
}

func (h *dictionaryHTTP) writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		h.logger.Error("write dictionary response", "error", err)
	}
}

// writeUnavailable answers requests that cannot reach the online dictionary API.
// Upstream errors may embed the configured address, so only the failure kind is logged.
func (h *dictionaryHTTP) writeUnavailable(w http.ResponseWriter, r *http.Request, err error) bool {
	notConfigured := errors.Is(err, dictionary.ErrNotConfigured)
	if !notConfigured && !errors.Is(err, dictionary.ErrUnavailable) {
		return false
	}
	h.logger.Warn("online dictionary unavailable", "request_id", RequestID(r), "not_configured", notConfigured)
	WriteProblem(w, h.logger, http.StatusServiceUnavailable, "The online dictionary is unavailable.")
	return true
}

func (h *dictionaryHTTP) getSettings(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	result, err := h.settings.Settings(r.Context(), viewer)
	if err != nil {
		h.writeSettingsError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, map[string]dictionary.Settings{"settings": result})
}

func (h *dictionaryHTTP) updateSettings(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	var patch dictionary.SettingsPatch
	if !h.common.decodeJSON(w, r, &patch) {
		return
	}
	result, err := h.settings.UpdateSettings(r.Context(), viewer, patch)
	if err != nil {
		h.writeSettingsError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, map[string]dictionary.Settings{"settings": result})
}

func (h *dictionaryHTTP) testConnection(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	status, err := h.settings.TestConnection(r.Context(), viewer)
	if err != nil {
		h.writeSettingsError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, map[string]dictionary.Status{"status": normalizeDictionaryStatus(status)})
}

// writeSettingsError never logs raw errors because they may contain the API address or key.
func (h *dictionaryHTTP) writeSettingsError(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case errors.Is(err, catalog.ErrForbidden):
		WriteProblem(w, h.logger, http.StatusForbidden, "")
	case errors.Is(err, dictionary.ErrInvalid):
		WriteProblem(w, h.logger, http.StatusBadRequest, "The dictionary settings are invalid.")
	case errors.Is(err, dictionary.ErrNotConfigured):
		WriteProblem(w, h.logger, http.StatusConflict, "Set the dictionary API address first.")
	case errors.Is(err, dictionary.ErrUnavailable):
		h.logger.Warn("dictionary API connection test failed", "request_id", RequestID(r))
		WriteProblem(w, h.logger, http.StatusBadGateway, "The dictionary API could not be reached.")
	default:
		h.logger.Error("dictionary settings request failed", "request_id", RequestID(r))
		WriteProblem(w, h.logger, http.StatusInternalServerError, "")
	}
}
