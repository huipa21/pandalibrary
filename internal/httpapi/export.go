package httpapi

import (
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"pandalibrary/internal/auth"
	notesexport "pandalibrary/internal/export"

	"github.com/go-chi/chi/v5"
)

type exportHTTP struct {
	service *notesexport.Service
	logger  *slog.Logger
}

// ExportMount registers the authenticated annotations export endpoint.
func ExportMount(service *notesexport.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &exportHTTP{service: service, logger: logger}
	return func(router chi.Router, _ Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/me/notes/export", handler.export)
		})
	}
}

func (h *exportHTTP) export(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := ViewerFromRequest(r)
	if !ok {
		WriteProblem(w, h.logger, http.StatusUnauthorized, "")
		return
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(values) != 1 || len(values["book_ids"]) != 1 {
		WriteProblem(w, h.logger, http.StatusBadRequest, "One book_ids parameter is required.")
		return
	}
	rawIDs := strings.Split(values.Get("book_ids"), ",")
	if len(rawIDs) < 1 || len(rawIDs) > 100 {
		WriteProblem(w, h.logger, http.StatusBadRequest, "Select between 1 and 100 distinct book IDs.")
		return
	}
	bookIDs := make([]int64, 0, len(rawIDs))
	seen := make(map[int64]struct{}, len(rawIDs))
	for _, rawID := range rawIDs {
		if rawID == "" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "A book ID is invalid.")
			return
		}
		for _, char := range rawID {
			if char < '0' || char > '9' {
				WriteProblem(w, h.logger, http.StatusBadRequest, "A book ID is invalid.")
				return
			}
		}
		id, err := strconv.ParseInt(rawID, 10, 64)
		if err != nil || id < 1 {
			WriteProblem(w, h.logger, http.StatusBadRequest, "A book ID is invalid.")
			return
		}
		if _, exists := seen[id]; exists {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Book IDs must be distinct.")
			return
		}
		seen[id] = struct{}{}
		bookIDs = append(bookIDs, id)
	}
	result, err := h.service.Export(r.Context(), notesexport.Viewer{
		UserID: user.ID, IsAdmin: user.Role == "admin",
	}, bookIDs)
	if err != nil {
		switch {
		case errors.Is(err, notesexport.ErrInvalid):
			WriteProblem(w, h.logger, http.StatusBadRequest, "The export selection is invalid.")
		case errors.Is(err, notesexport.ErrNotFound):
			WriteProblem(w, h.logger, http.StatusNotFound, "")
		case errors.Is(err, notesexport.ErrTooLarge):
			WriteProblem(w, h.logger, http.StatusRequestEntityTooLarge, "")
		default:
			h.logger.Error("notes export failed", "request_id", RequestID(r), "error", err)
			WriteProblem(w, h.logger, http.StatusInternalServerError, "")
		}
		return
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": result.Filename})
	if disposition == "" {
		h.logger.Error("format notes export attachment header", "request_id", RequestID(r))
		WriteProblem(w, h.logger, http.StatusInternalServerError, "")
		return
	}
	w.Header().Set("Content-Type", result.ContentType)
	w.Header().Set("Content-Disposition", disposition)
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(result.Body); err != nil {
		h.logger.Error("write notes export response", "request_id", RequestID(r), "error", err)
	}
}
