package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/search"

	"github.com/go-chi/chi/v5"
)

type searchHTTP struct {
	service *search.Service
	logger  *slog.Logger
}

// SearchMount registers the authenticated catalog search endpoint.
func SearchMount(service *search.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &searchHTTP{service: service, logger: logger}
	return func(router chi.Router, _ Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/search", handler.search)
		})
	}
}

func (h *searchHTTP) search(w http.ResponseWriter, r *http.Request) {
	user, ok := ViewerFromRequest(r)
	if !ok {
		h.logger.Error("search route has no authenticated viewer", "request_id", RequestID(r))
		WriteProblem(w, h.logger, http.StatusUnauthorized, "")
		return
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The query string is invalid.")
		return
	}
	for key, entries := range values {
		if (key != "q" && key != "limit" && key != "cursor") || len(entries) != 1 || entries[0] == "" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "A query parameter is invalid.")
			return
		}
	}
	if _, present := values["q"]; !present {
		WriteProblem(w, h.logger, http.StatusBadRequest, "A search query is required.")
		return
	}
	options := search.PageOptions{Cursor: values.Get("cursor")}
	if value := values.Get("limit"); value != "" {
		options.Limit, err = strconv.Atoi(value)
		if err != nil || options.Limit < 1 || options.Limit > 100 {
			WriteProblem(w, h.logger, http.StatusBadRequest, "The page limit must be between 1 and 100.")
			return
		}
	}
	result, err := h.service.Search(r.Context(), search.Viewer{
		UserID: user.ID, IsAdmin: user.Role == "admin",
	}, values.Get("q"), options)
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		if errors.Is(err, search.ErrInvalid) {
			WriteProblem(w, h.logger, http.StatusBadRequest, strings.TrimPrefix(err.Error(), "invalid search request: "))
		} else {
			h.logger.Error("search request failed", "request_id", RequestID(r), "error", err)
			WriteProblem(w, h.logger, http.StatusInternalServerError, "")
		}
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		h.logger.Error("write search response", "error", err)
	}
}
