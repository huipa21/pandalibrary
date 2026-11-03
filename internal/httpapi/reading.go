package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/reading"

	"github.com/go-chi/chi/v5"
)

const maxReadingJSONBytes = 2 << 20

type readingHTTP struct {
	service *reading.Service
	logger  *slog.Logger
}

// ReadingMount registers authenticated reading, annotation, and sync endpoints.
func ReadingMount(service *reading.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &readingHTTP{service: service, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/me/books/{id}", handler.getBookState)
			secured.Get("/api/v1/me/settings", handler.listSettings)
			secured.With(cookieProtection).Post("/api/v1/sync/push", handler.push)
			secured.Get("/api/v1/sync/pull", handler.pull)
			secured.Get("/api/v1/search/annotations", handler.searchAnnotations)
		})
	}
}

func (h *readingHTTP) getBookState(w http.ResponseWriter, r *http.Request) {
	viewer, ok := h.viewer(w, r)
	if !ok {
		return
	}
	bookID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || bookID < 1 {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The book ID is invalid.")
		return
	}
	result, err := h.service.GetBookState(r.Context(), viewer, bookID)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *readingHTTP) listSettings(w http.ResponseWriter, r *http.Request) {
	viewer, ok := h.viewer(w, r)
	if !ok {
		return
	}
	if _, valid := h.query(w, r); !valid {
		return
	}
	settings, err := h.service.ListSettings(r.Context(), viewer)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, struct {
		Settings []reading.Setting `json:"settings"`
	}{Settings: settings})
}

func (h *readingHTTP) push(w http.ResponseWriter, r *http.Request) {
	viewer, ok := h.viewer(w, r)
	if !ok {
		return
	}
	var request reading.PushRequest
	if !h.decodeJSON(w, r, &request) {
		return
	}
	result, err := h.service.Push(r.Context(), viewer, request)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *readingHTTP) pull(w http.ResponseWriter, r *http.Request) {
	viewer, ok := h.viewer(w, r)
	if !ok {
		return
	}
	values, valid := h.query(w, r, "cursor")
	if !valid {
		return
	}
	raw, exists := values["cursor"]
	if !exists || len(raw) != 1 || raw[0] == "" {
		WriteProblem(w, h.logger, http.StatusBadRequest, "A non-negative cursor is required.")
		return
	}
	cursor, err := strconv.ParseInt(raw[0], 10, 64)
	if err != nil || cursor < 0 || strconv.FormatInt(cursor, 10) != raw[0] {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The sync cursor is invalid.")
		return
	}
	result, err := h.service.Pull(r.Context(), viewer, cursor)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *readingHTTP) searchAnnotations(w http.ResponseWriter, r *http.Request) {
	viewer, ok := h.viewer(w, r)
	if !ok {
		return
	}
	values, valid := h.query(w, r, "q")
	if !valid {
		return
	}
	query, exists := values["q"]
	if !exists || len(query) != 1 {
		WriteProblem(w, h.logger, http.StatusBadRequest, "One annotation query is required.")
		return
	}
	items, err := h.service.SearchAnnotations(r.Context(), viewer, query[0])
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, struct {
		Items []reading.AnnotationResult `json:"items"`
	}{Items: items})
}

func (h *readingHTTP) viewer(w http.ResponseWriter, r *http.Request) (reading.Viewer, bool) {
	user, ok := ViewerFromRequest(r)
	if !ok {
		WriteProblem(w, h.logger, http.StatusUnauthorized, "")
		return reading.Viewer{}, false
	}
	return reading.Viewer{UserID: user.ID, IsAdmin: user.Role == "admin"}, true
}

func (h *readingHTTP) query(w http.ResponseWriter, r *http.Request, allowed ...string) (url.Values, bool) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The query string is invalid.")
		return nil, false
	}
	allowedKeys := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedKeys[key] = struct{}{}
	}
	for key, entries := range values {
		if _, ok := allowedKeys[key]; !ok || len(entries) != 1 {
			WriteProblem(w, h.logger, http.StatusBadRequest, "A query parameter is invalid.")
			return nil, false
		}
	}
	return values, true
}

func (h *readingHTTP) decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	reader := http.MaxBytesReader(w, r.Body, maxReadingJSONBytes)
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		h.writeDecodeError(w, err)
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		h.writeDecodeError(w, err)
		return false
	}
	return true
}

func (h *readingHTTP) writeDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		WriteProblem(w, h.logger, http.StatusRequestEntityTooLarge, "")
		return
	}
	WriteProblem(w, h.logger, http.StatusBadRequest, "The JSON request body is invalid.")
}

func (h *readingHTTP) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		h.logger.Error("write reading response", "error", err)
	}
}

func (h *readingHTTP) writeError(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case errors.Is(err, reading.ErrInvalid):
		WriteProblem(w, h.logger, http.StatusBadRequest, strings.TrimPrefix(err.Error(), "invalid reading request: "))
	case errors.Is(err, reading.ErrNotFound):
		WriteProblem(w, h.logger, http.StatusNotFound, "")
	default:
		h.logger.Error("reading request failed", "request_id", RequestID(r), "error", err)
		WriteProblem(w, h.logger, http.StatusInternalServerError, "")
	}
}
