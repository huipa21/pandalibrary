package httpapi

import (
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/importer"
)

type importHTTP struct {
	service *importer.Service
	catalog *catalogHTTP
}

func ImportMount(service *importer.Service, catalogService *catalog.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &importHTTP{service: service, catalog: &catalogHTTP{service: catalogService, logger: logger}}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(admin chi.Router) {
			admin.Use(SessionMiddleware(authentication, logger))
			admin.Use(RequireRole("admin", logger))
			admin.With(cookieProtection).Post("/api/v1/uploads", handler.catalog.withViewer(handler.upload(false)))
			admin.With(cookieProtection).Post("/api/v1/books/{id}/files", handler.catalog.withViewer(handler.upload(true)))
			admin.Get("/api/v1/imports", handler.catalog.withViewer(handler.history))
		})
	}
}

func (h *importHTTP) history(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	values, ok := h.catalog.query(w, r, "limit", "cursor")
	if !ok {
		return
	}
	options, ok := h.catalog.pageOptions(w, values)
	if !ok {
		return
	}
	if options.Limit == 0 {
		options.Limit = 50
	}
	var before int64
	if options.Cursor != "" {
		var err error
		before, err = strconv.ParseInt(options.Cursor, 10, 64)
		if err != nil || before < 1 {
			WriteProblem(w, h.catalog.logger, http.StatusBadRequest, "The import cursor is invalid.")
			return
		}
	}
	page, err := h.service.History(r.Context(), viewer, before, options.Limit)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.catalog.writeJSON(w, http.StatusOK, page)
}

func (h *importHTTP) upload(attachment bool) catalogHandler {
	return func(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
		var libraryID, bookID int64
		if attachment {
			id, ok := h.catalog.pathID(w, r, "id")
			if !ok {
				return
			}
			book, err := h.catalog.service.GetBook(r.Context(), viewer, id)
			if err != nil {
				h.writeError(w, r, err)
				return
			}
			libraryID, bookID = book.LibraryID, book.ID
		}
		reader, err := r.MultipartReader()
		if err != nil {
			h.multipartError(w, r, err)
			return
		}
		var staged blobstore.StagedBook
		queued := false
		defer func() {
			if !queued && staged.Token != "" {
				if err := h.service.Discard(staged); err != nil {
					h.catalog.logger.Error("discard upload", "request_id", RequestID(r), "error", err)
				}
			}
		}()
		fileName := ""
		seenLibrary := false
		visibility := "public"
		seenVisibility := false
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
			switch params["name"] {
			case "visibility":
				value, err := io.ReadAll(io.LimitReader(part, 16))
				if err != nil || attachment || seenVisibility || params["filename"] != "" || (string(value) != "public" && string(value) != "private") {
					h.multipartError(w, r, catalog.ErrInvalid)
					return
				}
				visibility, seenVisibility = string(value), true
			case "library_id":
				if attachment || seenLibrary || params["filename"] != "" {
					h.multipartError(w, r, catalog.ErrInvalid)
					return
				}
				value, err := io.ReadAll(io.LimitReader(part, 33))
				if err != nil {
					h.multipartError(w, r, err)
					return
				}
				libraryID, err = strconv.ParseInt(string(value), 10, 64)
				if err != nil || libraryID < 1 || len(value) > 32 {
					h.multipartError(w, r, catalog.ErrInvalid)
					return
				}
				if _, err := h.catalog.service.GetLibrary(r.Context(), viewer, libraryID); err != nil {
					h.writeError(w, r, err)
					return
				}
				seenLibrary = true
			case "file":
				if fileName != "" || !importer.ValidFilename(params["filename"]) {
					h.multipartError(w, r, catalog.ErrInvalid)
					return
				}
				fileName = params["filename"]
				staged, err = h.service.Stage(r.Context(), multipartInput{Reader: part})
				if err != nil {
					h.writeError(w, r, err)
					return
				}
			default:
				h.multipartError(w, r, catalog.ErrInvalid)
				return
			}
			if err := part.Close(); err != nil {
				h.multipartError(w, r, err)
				return
			}
		}
		if fileName == "" || !attachment && !seenLibrary {
			h.multipartError(w, r, catalog.ErrInvalid)
			return
		}
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			h.multipartError(w, r, err)
			return
		}
		job, err := h.service.QueueUpload(r.Context(), viewer, libraryID, bookID, fileName, staged, visibility)
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		queued = true
		h.catalog.writeJSON(w, http.StatusAccepted, map[string]importer.Job{"job": job})
	}
}

type multipartInput struct{ io.Reader }

func (input multipartInput) Read(buffer []byte) (int, error) {
	count, err := input.Reader.Read(buffer)
	if err != nil && !errors.Is(err, io.EOF) {
		err = errors.Join(catalog.ErrInvalid, err)
	}
	return count, err
}

func (h *importHTTP) multipartError(w http.ResponseWriter, r *http.Request, err error) {
	h.writeError(w, r, errors.Join(catalog.ErrInvalid, err))
}

func (h *importHTTP) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		WriteProblem(w, h.catalog.logger, http.StatusRequestEntityTooLarge, "")
	case errors.Is(err, blobstore.ErrEmptyBook), errors.Is(err, catalog.ErrInvalid):
		WriteProblem(w, h.catalog.logger, http.StatusBadRequest, "The multipart upload is invalid.")
	case errors.Is(err, importer.ErrStopped):
		WriteProblem(w, h.catalog.logger, http.StatusServiceUnavailable, "")
	default:
		h.catalog.writeError(w, r, err)
	}
}
