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

// DictionaryAdminService manages online dictionary providers and the lookup cache.
// Implementations return catalog.ErrForbidden for non-administrators, dictionary.ErrInvalid
// for rejected input, dictionary.ErrNotFound for unknown IDs, dictionary.ErrNotConfigured when
// a provider cannot be tested (no key or address) and dictionary.ErrUnavailable when it
// cannot be reached.
type DictionaryAdminService interface {
	ListProviders(ctx context.Context, viewer catalog.Viewer) (dictionary.Providers, error)
	CreateProvider(ctx context.Context, viewer catalog.Viewer, input dictionary.ProviderInput) (dictionary.Provider, error)
	UpdateProvider(ctx context.Context, viewer catalog.Viewer, id int64, patch dictionary.ProviderPatch) (dictionary.Provider, error)
	DeleteProvider(ctx context.Context, viewer catalog.Viewer, id int64) error
	TestProvider(ctx context.Context, viewer catalog.Viewer, id int64) (dictionary.Status, error)
	ClearCache(ctx context.Context, viewer catalog.Viewer) (int64, error)
}

type dictionaryHTTP struct {
	service DictionaryService
	admin   DictionaryAdminService
	common  *catalogHTTP
	logger  *slog.Logger
}

// DictionaryMount registers the authenticated dictionary lookup endpoints and the
// administrator-only online dictionary provider endpoints.
func DictionaryMount(service DictionaryService, admin DictionaryAdminService, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &dictionaryHTTP{service: service, admin: admin, common: &catalogHTTP{logger: logger}, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/dictionary/status", handler.status)
			secured.Get("/api/v1/dictionary/lookup", handler.lookup)
		})
		router.Group(func(admin chi.Router) {
			admin.Use(SessionMiddleware(authentication, logger))
			admin.Use(RequireRole("admin", logger))
			admin.Get("/api/v1/admin/dictionary/providers", handler.common.withViewer(handler.listProviders))
			admin.With(cookieProtection).Post("/api/v1/admin/dictionary/providers", handler.common.withViewer(handler.createProvider))
			admin.With(cookieProtection).Patch("/api/v1/admin/dictionary/providers/{id}", handler.common.withViewer(handler.updateProvider))
			admin.With(cookieProtection).Delete("/api/v1/admin/dictionary/providers/{id}", handler.common.withViewer(handler.deleteProvider))
			admin.With(cookieProtection).Post("/api/v1/admin/dictionary/providers/{id}/test", handler.common.withViewer(handler.testProvider))
			admin.With(cookieProtection).Delete("/api/v1/admin/dictionary/cache", handler.common.withViewer(handler.clearCache))
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

func (h *dictionaryHTTP) listProviders(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	result, err := h.admin.ListProviders(r.Context(), viewer)
	if err != nil {
		h.writeAdminError(w, r, err)
		return
	}
	if result.Providers == nil {
		result.Providers = []dictionary.Provider{}
	}
	for index := range result.Providers {
		result.Providers[index] = normalizeDictionaryProvider(result.Providers[index])
	}
	h.common.writeJSON(w, http.StatusOK, result)
}

func (h *dictionaryHTTP) createProvider(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	var input dictionary.ProviderInput
	if !h.decodeJSON(w, r, &input) {
		return
	}
	provider, err := h.admin.CreateProvider(r.Context(), viewer, input)
	if err != nil {
		h.writeAdminError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusCreated, map[string]dictionary.Provider{"provider": normalizeDictionaryProvider(provider)})
}

func (h *dictionaryHTTP) updateProvider(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.providerID(w, r)
	if !ok {
		return
	}
	var patch dictionary.ProviderPatch
	if !h.decodeJSON(w, r, &patch) {
		return
	}
	provider, err := h.admin.UpdateProvider(r.Context(), viewer, id, patch)
	if err != nil {
		h.writeAdminError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, map[string]dictionary.Provider{"provider": normalizeDictionaryProvider(provider)})
}

func (h *dictionaryHTTP) deleteProvider(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.providerID(w, r)
	if !ok {
		return
	}
	if err := h.admin.DeleteProvider(r.Context(), viewer, id); err != nil {
		h.writeAdminError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (h *dictionaryHTTP) testProvider(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.providerID(w, r)
	if !ok {
		return
	}
	status, err := h.admin.TestProvider(r.Context(), viewer, id)
	if err != nil {
		h.writeAdminError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, map[string]dictionary.Status{"status": normalizeDictionaryStatus(status)})
}

func (h *dictionaryHTTP) clearCache(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	deleted, err := h.admin.ClearCache(r.Context(), viewer)
	if err != nil {
		h.writeAdminError(w, r, err)
		return
	}
	h.common.writeJSON(w, http.StatusOK, map[string]int64{"deleted": deleted})
}

func normalizeDictionaryProvider(provider dictionary.Provider) dictionary.Provider {
	if provider.Directions == nil {
		provider.Directions = []dictionary.Direction{}
	}
	for index := range provider.Directions {
		if provider.Directions[index].Sources == nil {
			provider.Directions[index].Sources = []string{}
		}
	}
	return provider
}

func (h *dictionaryHTTP) providerID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	w.Header().Set("Cache-Control", "no-store")
	return h.common.pathID(w, r, "id")
}

func (h *dictionaryHTTP) decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	w.Header().Set("Cache-Control", "no-store")
	return h.common.decodeJSON(w, r, target)
}

// writeAdminError never logs raw errors because they may contain a provider address or API key.
func (h *dictionaryHTTP) writeAdminError(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case errors.Is(err, catalog.ErrForbidden):
		WriteProblem(w, h.logger, http.StatusForbidden, "")
	case errors.Is(err, dictionary.ErrInvalid):
		WriteProblem(w, h.logger, http.StatusBadRequest, "The dictionary provider settings are invalid.")
	case errors.Is(err, dictionary.ErrNotFound):
		WriteProblem(w, h.logger, http.StatusNotFound, "")
	case errors.Is(err, dictionary.ErrNotConfigured):
		WriteProblem(w, h.logger, http.StatusConflict, "Enter the provider's API key or address first.")
	case errors.Is(err, dictionary.ErrUnavailable):
		h.logger.Warn("dictionary provider test failed", "request_id", RequestID(r))
		WriteProblem(w, h.logger, http.StatusBadGateway, "The dictionary provider could not be reached.")
	default:
		h.logger.Error("dictionary admin request failed", "request_id", RequestID(r))
		WriteProblem(w, h.logger, http.StatusInternalServerError, "")
	}
}
