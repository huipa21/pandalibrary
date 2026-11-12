package httpapi

import (
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"

	"github.com/go-chi/chi/v5"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/bookheap"
	"pandalibrary/internal/catalog"
)

type bookheapHTTP struct {
	service *bookheap.Service
	catalog *catalogHTTP
}

// BookheapMount exposes the admin-only bookheap API.
func BookheapMount(service *bookheap.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &bookheapHTTP{service: service, catalog: &catalogHTTP{logger: logger}}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(admin chi.Router) {
			admin.Use(SessionMiddleware(authentication, logger))
			admin.Use(RequireRole("admin", logger))
			admin.With(cookieProtection).Post("/api/v1/admin/bookheap/files", handler.catalog.withViewer(handler.upload))
			admin.Get("/api/v1/admin/bookheap/items", handler.catalog.withViewer(handler.list))
			admin.Get("/api/v1/admin/bookheap/items/{id}", handler.catalog.withViewer(handler.get))
			admin.Get("/api/v1/admin/bookheap/items/{id}/cover", handler.catalog.withViewer(handler.cover))
			admin.With(cookieProtection).Post("/api/v1/admin/bookheap/items/delete", handler.catalog.withViewer(handler.delete))
			admin.With(cookieProtection).Post("/api/v1/admin/bookheap/scan", handler.catalog.withViewer(handler.startScan))
			admin.Get("/api/v1/admin/bookheap/scan", handler.catalog.withViewer(handler.latestScan))
		})
	}
}

func (h *bookheapHTTP) upload(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	reader, err := r.MultipartReader()
	if err != nil {
		h.multipartError(w, r, err)
		return
	}
	var pending *bookheap.Pending
	visibility := "public"
	seenVisibility := false
	defer func() {
		if err := pending.Discard(); err != nil {
			h.catalog.logger.Error("discard bookheap upload", "request_id", RequestID(r), "error", err)
		}
	}()
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			h.multipartError(w, r, err)
			return
		}
		disposition, params, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		if err != nil || disposition != "form-data" {
			h.multipartError(w, r, catalog.ErrInvalid)
			return
		}
		if params["name"] == "visibility" {
			value, err := io.ReadAll(io.LimitReader(part, 16))
			if err != nil || seenVisibility || params["filename"] != "" || (string(value) != "public" && string(value) != "private") {
				h.multipartError(w, r, catalog.ErrInvalid)
				return
			}
			visibility, seenVisibility = string(value), true
			if err := part.Close(); err != nil {
				h.multipartError(w, r, err)
				return
			}
			continue
		}
		if params["name"] != "file" || pending != nil {
			h.multipartError(w, r, catalog.ErrInvalid)
			return
		}
		input := &recordingReader{reader: part}
		pending, err = h.service.Receive(r.Context(), viewer, params["filename"], input)
		if input.err != nil {
			h.multipartError(w, r, input.err)
			return
		}
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		if err := part.Close(); err != nil {
			h.multipartError(w, r, err)
			return
		}
	}
	if pending == nil {
		h.multipartError(w, r, catalog.ErrInvalid)
		return
	}
	if _, err := io.Copy(io.Discard, r.Body); err != nil {
		h.multipartError(w, r, err)
		return
	}
	if err := pending.SetVisibility(visibility); err != nil {
		h.writeError(w, r, err)
		return
	}
	item, err := h.service.Commit(r.Context(), viewer, pending)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.catalog.writeJSON(w, http.StatusCreated, map[string]bookheap.Item{"item": item})
}

func (h *bookheapHTTP) list(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	values, ok := h.catalog.query(w, r, "status", "q", "limit", "cursor")
	if !ok {
		return
	}
	page, ok := h.catalog.pageOptions(w, values)
	if !ok {
		return
	}
	result, err := h.service.List(r.Context(), viewer, bookheap.ListOptions{
		Status: values.Get("status"), Query: values.Get("q"), Limit: page.Limit, Cursor: page.Cursor,
	})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.catalog.writeJSON(w, http.StatusOK, result)
}

func (h *bookheapHTTP) get(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.catalog.pathID(w, r, "id")
	if !ok {
		return
	}
	item, err := h.service.Get(r.Context(), viewer, id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.catalog.writeJSON(w, http.StatusOK, map[string]bookheap.Item{"item": item})
}

func (h *bookheapHTTP) cover(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	id, ok := h.catalog.pathID(w, r, "id")
	if !ok {
		return
	}
	values, ok := h.catalog.query(w, r, "thumbnail")
	if !ok {
		return
	}
	thumbnail := false
	switch values.Get("thumbnail") {
	case "", "0":
	case "1":
		thumbnail = true
	default:
		WriteProblem(w, h.catalog.logger, http.StatusBadRequest, "The thumbnail parameter must be 0 or 1.")
		return
	}
	content, err := h.service.OpenCover(r.Context(), viewer, id, thumbnail)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.catalog.serveContent(w, r, content, false)
}

func (h *bookheapHTTP) delete(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if !h.catalog.decodeJSON(w, r, &body) {
		return
	}
	results, err := h.service.Delete(r.Context(), viewer, body.IDs)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.catalog.writeJSON(w, http.StatusOK, map[string][]bookheap.DeleteResult{"results": results})
}

func (h *bookheapHTTP) startScan(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	if r.ContentLength > 0 {
		WriteProblem(w, h.catalog.logger, http.StatusBadRequest, "The scan request takes no body.")
		return
	}
	scan, started, err := h.service.StartScan(viewer)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	status := http.StatusOK
	if started {
		status = http.StatusAccepted
	}
	h.catalog.writeJSON(w, status, map[string]bookheap.Scan{"scan": scan})
}

func (h *bookheapHTTP) latestScan(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	scan, err := h.service.LatestScan(viewer)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.catalog.writeJSON(w, http.StatusOK, map[string]*bookheap.Scan{"scan": scan})
}

// recordingReader remembers request read failures so they are reported as
// client errors instead of server errors.
type recordingReader struct {
	reader io.Reader
	err    error
}

func (r *recordingReader) Read(buffer []byte) (int, error) {
	count, err := r.reader.Read(buffer)
	if err != nil && !errors.Is(err, io.EOF) {
		r.err = err
	}
	return count, err
}

func (h *bookheapHTTP) multipartError(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		WriteProblem(w, h.catalog.logger, http.StatusRequestEntityTooLarge, "")
		return
	}
	WriteProblem(w, h.catalog.logger, http.StatusBadRequest, "The multipart upload is invalid.")
}

func (h *bookheapHTTP) writeError(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	var duplicate *bookheap.DuplicateError
	switch {
	case errors.Is(err, bookheap.ErrTooLarge):
		WriteProblem(w, h.catalog.logger, http.StatusRequestEntityTooLarge, "")
	case errors.As(err, &duplicate):
		extensions := map[string]any{"duplicate_of_item_id": duplicate.ItemID}
		detail := "This file is already in the bookheap."
		if duplicate.BookID == 0 && duplicate.ItemID == 0 {
			extensions = nil
			detail = "This file has already been uploaded."
		}
		if duplicate.BookID != 0 {
			extensions = map[string]any{"duplicate_of_book_id": duplicate.BookID}
			detail = "This file is already in the library."
		}
		WriteProblemWith(w, h.catalog.logger, http.StatusConflict, detail, extensions)
	case errors.Is(err, bookheap.ErrUnsupported):
		WriteProblem(w, h.catalog.logger, http.StatusUnsupportedMediaType, "The file is not a supported or readable ebook.")
	case errors.Is(err, bookheap.ErrStopped):
		WriteProblem(w, h.catalog.logger, http.StatusServiceUnavailable, "")
	default:
		h.catalog.writeError(w, r, err)
	}
}
