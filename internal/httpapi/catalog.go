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
	"pandalibrary/internal/catalog"

	"github.com/go-chi/chi/v5"
)

const maxCatalogJSONBytes = 2 << 20

type catalogHTTP struct {
	service *catalog.Service
	logger  *slog.Logger
}

type catalogHandler func(http.ResponseWriter, *http.Request, catalog.Viewer)

// CatalogMount registers authenticated catalog and administrator routes.
func CatalogMount(service *catalog.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &catalogHTTP{service: service, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.Get("/api/v1/libraries", handler.withViewer(handler.listLibraries))
			secured.Get("/api/v1/libraries/{id}", handler.withViewer(handler.getLibrary))
			secured.Get("/api/v1/books", handler.withViewer(handler.listBooks))
			secured.Get("/api/v1/books/count", handler.withViewer(handler.countBooks))
			secured.Get("/api/v1/books/{id}", handler.withViewer(handler.getBook))
			secured.With(cookieProtection).Put("/api/v1/books/{id}/visibility", handler.withViewer(handler.setVisibility))
			secured.Get("/api/v1/books/{id}/files/{fileID}", handler.withViewer(handler.serveBookFile))
			secured.Head("/api/v1/books/{id}/files/{fileID}", handler.withViewer(handler.serveBookFile))
			secured.Get("/api/v1/books/{id}/cover", handler.withViewer(handler.serveCover))
			secured.Head("/api/v1/books/{id}/cover", handler.withViewer(handler.serveCover))
			for _, kind := range []string{"authors", "series", "tags"} {
				secured.Get("/api/v1/"+kind, handler.withViewer(handler.listEntities(kind)))
				secured.Get("/api/v1/"+kind+"/{id}", handler.withViewer(handler.getEntity(kind)))
			}
			secured.Group(func(admin chi.Router) {
				admin.Use(RequireRole("admin", logger))
				admin.Get("/api/v1/admin/libraries", handler.withViewer(handler.listLibraries))
				admin.With(cookieProtection).Post("/api/v1/admin/libraries", handler.withViewer(handler.createLibrary))
				admin.With(cookieProtection).Patch("/api/v1/admin/libraries/{id}", handler.withViewer(handler.updateLibrary))
				admin.With(cookieProtection).Delete("/api/v1/admin/libraries/{id}", handler.withViewer(handler.deleteLibrary))
				admin.Get("/api/v1/admin/libraries/{id}/access", handler.withViewer(handler.listAccess))
				admin.With(cookieProtection).Put("/api/v1/admin/libraries/{id}/access/{userID}", handler.withViewer(handler.setAccess(true)))
				admin.With(cookieProtection).Delete("/api/v1/admin/libraries/{id}/access/{userID}", handler.withViewer(handler.setAccess(false)))
				admin.Get("/api/v1/admin/users/{userID}/hidden-books", handler.withViewer(handler.listHidden))
				admin.With(cookieProtection).Put("/api/v1/admin/users/{userID}/hidden-books/{bookID}", handler.withViewer(handler.setHidden(true)))
				admin.With(cookieProtection).Delete("/api/v1/admin/users/{userID}/hidden-books/{bookID}", handler.withViewer(handler.setHidden(false)))
				admin.With(cookieProtection).Patch("/api/v1/books/{id}", handler.withViewer(handler.updateBook))
				admin.With(cookieProtection).Delete("/api/v1/books/{id}", handler.withViewer(handler.deleteBook))
				admin.With(cookieProtection).Put("/api/v1/books/{id}/cover", handler.withViewer(handler.updateCover))
			})
		})
	}
}

func (h *catalogHTTP) withViewer(next catalogHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := ViewerFromRequest(r)
		if !ok {
			h.logger.Error("catalog route has no authenticated viewer", "request_id", RequestID(r))
			WriteProblem(w, h.logger, http.StatusUnauthorized, "")
			return
		}
		next(w, r, catalog.Viewer{UserID: user.ID, IsAdmin: user.Role == "admin"})
	}
}

func (h *catalogHTTP) listLibraries(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	values, ok := h.query(w, r, "limit", "cursor")
	if !ok {
		return
	}
	page, ok := h.pageOptions(w, values)
	if !ok {
		return
	}
	result, err := h.service.ListLibraries(r.Context(), viewer, page)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *catalogHTTP) getLibrary(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	result, err := h.service.GetLibrary(r.Context(), viewer, id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]catalog.Library{"library": result})
}

func (h *catalogHTTP) listBooks(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	values, ok := h.query(w, r, "limit", "cursor", "sort", "library_id", "author_id", "series_id", "tag_id")
	if !ok {
		return
	}
	page, ok := h.pageOptions(w, values)
	if !ok {
		return
	}
	var filters catalog.BookFilters
	for _, field := range []struct {
		name string
		dest *int64
	}{
		{"library_id", &filters.LibraryID}, {"author_id", &filters.AuthorID},
		{"series_id", &filters.SeriesID}, {"tag_id", &filters.TagID},
	} {
		if value, present := values[field.name]; present {
			id, err := strconv.ParseInt(value[0], 10, 64)
			if err != nil || id < 1 {
				WriteProblem(w, h.logger, http.StatusBadRequest, "A catalog filter ID is invalid.")
				return
			}
			*field.dest = id
		}
	}
	if value, present := values["sort"]; present {
		filters.Sort = value[0]
		if filters.Sort == "" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "The sort value is invalid.")
			return
		}
	}
	result, err := h.service.ListBooks(r.Context(), viewer, filters, page)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *catalogHTTP) countBooks(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	count, err := h.service.CountBooks(r.Context(), viewer)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]int64{"count": count})
}

func (h *catalogHTTP) getBook(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}

	result, err := h.service.GetBook(r.Context(), viewer, id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]catalog.Book{"book": result})
}

func (h *catalogHTTP) setVisibility(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	var body struct {
		Visibility string `json:"visibility"`
	}
	if !h.decodeJSON(w, r, &body) {
		return
	}
	book, err := h.service.SetVisibility(r.Context(), viewer, id, body.Visibility)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]catalog.Book{"book": book})
}

func (h *catalogHTTP) listEntities(kind string) catalogHandler {
	return func(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
		values, ok := h.query(w, r, "limit", "cursor")
		if !ok {
			return
		}
		page, ok := h.pageOptions(w, values)
		if !ok {
			return
		}
		result, err := h.service.ListEntities(r.Context(), viewer, kind, page)
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		h.writeJSON(w, http.StatusOK, result)
	}
}

func (h *catalogHTTP) getEntity(kind string) catalogHandler {
	return func(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
		id, ok := h.pathID(w, r, "id")
		if !ok {
			return
		}
		result, err := h.service.GetEntity(r.Context(), viewer, kind, id)
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		name := map[string]string{"authors": "author", "series": "series", "tags": "tag"}[kind]
		h.writeJSON(w, http.StatusOK, map[string]catalog.Entity{name: result})
	}
}

func (h *catalogHTTP) createLibrary(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	var request struct {
		Name string `json:"name"`
		Slug string `json:"slug"`
	}
	if !h.decodeJSON(w, r, &request) {
		return
	}
	result, err := h.service.CreateLibrary(r.Context(), viewer, request.Name, request.Slug)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusCreated, map[string]catalog.Library{"library": result})
}

func (h *catalogHTTP) updateLibrary(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	var request catalog.LibraryPatch
	if !h.decodeJSON(w, r, &request) {
		return
	}
	result, err := h.service.UpdateLibrary(r.Context(), viewer, id, request)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]catalog.Library{"library": result})
}

func (h *catalogHTTP) deleteLibrary(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	if err := h.service.DeleteLibrary(r.Context(), viewer, id); err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (h *catalogHTTP) listAccess(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	values, ok := h.query(w, r, "limit", "cursor")
	if !ok {
		return
	}
	page, ok := h.pageOptions(w, values)
	if !ok {
		return
	}
	result, err := h.service.ListAccess(r.Context(), viewer, id, page)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *catalogHTTP) setAccess(grant bool) catalogHandler {
	return func(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
		libraryID, ok := h.pathID(w, r, "id")
		if !ok {
			return
		}
		userID, ok := h.pathID(w, r, "userID")
		if !ok {
			return
		}
		if err := h.service.SetAccess(r.Context(), viewer, libraryID, userID, grant); err != nil {
			h.writeError(w, r, err)
			return
		}
		if grant {
			h.writeJSON(w, http.StatusOK, map[string]bool{"granted": true})
		} else {
			h.writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
		}
	}
}

func (h *catalogHTTP) listHidden(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "userID")
	if !ok {
		return
	}
	values, ok := h.query(w, r, "limit", "cursor")
	if !ok {
		return
	}
	page, ok := h.pageOptions(w, values)
	if !ok {
		return
	}
	result, err := h.service.ListHidden(r.Context(), viewer, id, page)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}

func (h *catalogHTTP) setHidden(hidden bool) catalogHandler {
	return func(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
		userID, ok := h.pathID(w, r, "userID")
		if !ok {
			return
		}
		bookID, ok := h.pathID(w, r, "bookID")
		if !ok {
			return
		}
		if err := h.service.SetHidden(r.Context(), viewer, userID, bookID, hidden); err != nil {
			h.writeError(w, r, err)
			return
		}
		h.writeJSON(w, http.StatusOK, map[string]bool{"hidden": hidden})
	}
}

func (h *catalogHTTP) updateBook(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	var request catalog.BookPatch
	if !h.decodeJSON(w, r, &request) {
		return
	}
	result, err := h.service.UpdateBook(r.Context(), viewer, id, request)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]catalog.Book{"book": result})
}

func (h *catalogHTTP) deleteBook(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	if err := h.service.DeleteBook(r.Context(), viewer, id); err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (h *catalogHTTP) pathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	if err != nil || id < 1 {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The resource ID is invalid.")
		return 0, false
	}
	return id, true
}

func (h *catalogHTTP) query(w http.ResponseWriter, r *http.Request, allowed ...string) (url.Values, bool) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The query string is invalid.")
		return nil, false
	}
	known := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		known[key] = true
	}
	for key, entries := range values {
		if !known[key] || len(entries) != 1 || entries[0] == "" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "A query parameter is invalid.")
			return nil, false
		}
	}
	return values, true
}

func (h *catalogHTTP) pageOptions(w http.ResponseWriter, values url.Values) (catalog.PageOptions, bool) {
	options := catalog.PageOptions{Cursor: values.Get("cursor")}
	if value := values.Get("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			WriteProblem(w, h.logger, http.StatusBadRequest, "The page limit must be between 1 and 100.")
			return catalog.PageOptions{}, false
		}
		options.Limit = limit
	}
	return options, true
}

func (h *catalogHTTP) decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	reader := http.MaxBytesReader(w, r.Body, maxCatalogJSONBytes)
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

func (h *catalogHTTP) writeDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		WriteProblem(w, h.logger, http.StatusRequestEntityTooLarge, "")
		return
	}
	WriteProblem(w, h.logger, http.StatusBadRequest, "The JSON request body is invalid.")
}

func (h *catalogHTTP) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		h.logger.Error("write catalog response", "error", err)
	}
}

func (h *catalogHTTP) writeError(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case errors.Is(err, catalog.ErrInvalid):
		WriteProblem(w, h.logger, http.StatusBadRequest, strings.TrimPrefix(err.Error(), "invalid request: "))
	case errors.Is(err, catalog.ErrNotFound):
		WriteProblem(w, h.logger, http.StatusNotFound, "")
	case errors.Is(err, catalog.ErrForbidden):
		WriteProblem(w, h.logger, http.StatusForbidden, "")
	case errors.Is(err, catalog.ErrConflict):
		WriteProblem(w, h.logger, http.StatusConflict, strings.TrimPrefix(err.Error(), "conflict: "))
	case errors.Is(err, catalog.ErrTooLarge):
		WriteProblem(w, h.logger, http.StatusRequestEntityTooLarge, "")
	default:
		h.logger.Error("catalog request failed", "request_id", RequestID(r), "error", err)
		WriteProblem(w, h.logger, http.StatusInternalServerError, "")
	}
}
