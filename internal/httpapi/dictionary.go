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
	"pandalibrary/internal/dictionary"

	"github.com/go-chi/chi/v5"
)

// DictionaryService answers dictionary lookups and reports installed dictionaries.
type DictionaryService interface {
	Lookup(ctx context.Context, query dictionary.Query) (dictionary.Result, error)
	Status(ctx context.Context) (dictionary.Status, error)
}

type dictionaryHTTP struct {
	service DictionaryService
	logger  *slog.Logger
}

// DictionaryMount registers the authenticated dictionary lookup endpoints.
func DictionaryMount(service DictionaryService, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &dictionaryHTTP{service: service, logger: logger}
	return func(router chi.Router, _ Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/dictionary/status", handler.status)
			secured.Get("/api/v1/dictionary/lookup", handler.lookup)
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
		h.logger.Error("dictionary status failed", "request_id", RequestID(r), "error", err)
		WriteProblem(w, h.logger, http.StatusInternalServerError, "")
		return
	}
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
	h.writeJSON(w, status)
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
		} else {
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
