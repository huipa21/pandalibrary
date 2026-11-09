package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"pandalibrary/internal/annotations"
	"pandalibrary/internal/auth"
)

func AnnotationAssetsMount(service *annotations.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	handler := &annotationAssetsHTTP{service: service, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(authentication, logger))
			secured.With(cookieProtection).Post("/api/v1/me/annotation-assets", handler.upload)
			secured.Get("/api/v1/me/annotation-assets/{sha256}", handler.download)
		})
	}
}

type annotationAssetsHTTP struct {
	service *annotations.Service
	logger  *slog.Logger
}

func (h *annotationAssetsHTTP) upload(w http.ResponseWriter, r *http.Request) {
	viewer, ok := ViewerFromRequest(r)
	if !ok {
		WriteProblem(w, h.logger, http.StatusUnauthorized, "")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "image/png" && mediaType != "image/jpeg" && mediaType != "image/webp" {
		h.writeError(w, r, annotations.ErrUnsupportedMedia)
		return
	}
	if r.ContentLength > annotations.MaxBytes {
		h.writeError(w, r, annotations.ErrTooLarge)
		return
	}
	content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, annotations.MaxBytes+1))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			h.writeError(w, r, annotations.ErrTooLarge)
		} else {
			h.logger.Warn("read annotation asset request", "request_id", RequestID(r), "error", err)
			h.writeError(w, r, annotations.ErrInvalidImage)
		}
		return
	}
	asset, created, err := h.service.Upload(r.Context(), viewer.ID, mediaType, content)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(struct {
		Asset annotations.Asset `json:"asset"`
	}{Asset: asset}); err != nil {
		h.logger.Error("write annotation asset response", "request_id", RequestID(r), "error", err)
	}
}

func (h *annotationAssetsHTTP) download(w http.ResponseWriter, r *http.Request) {
	viewer, ok := ViewerFromRequest(r)
	if !ok {
		WriteProblem(w, h.logger, http.StatusUnauthorized, "")
		return
	}
	asset, file, err := h.service.Open(r.Context(), viewer.ID, chi.URLParam(r, "sha256"))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	defer func() {
		if err := file.Close(); err != nil {
			h.logger.Error("close annotation asset", "request_id", RequestID(r), "error", err)
		}
	}()
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", asset.MediaType)
	w.Header().Set("Content-Length", strconv.FormatInt(asset.Size, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self'")
	if _, err := io.Copy(w, file); err != nil {
		h.logger.Error("stream annotation asset", "request_id", RequestID(r), "error", err)
	}
}

func (h *annotationAssetsHTTP) writeError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, annotations.ErrTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, annotations.ErrUnsupportedMedia):
		status = http.StatusUnsupportedMediaType
	case errors.Is(err, annotations.ErrInvalidImage), errors.Is(err, annotations.ErrInvalidDimensions),
		errors.Is(err, annotations.ErrInvalidHash):
		status = http.StatusBadRequest
	case errors.Is(err, annotations.ErrNotFound):
		status = http.StatusNotFound
	default:
		h.logger.Error("annotation asset request failed", "request_id", RequestID(r), "error", err)
		WriteProblem(w, h.logger, status, "")
		return
	}
	WriteProblemWith(w, h.logger, status, "", map[string]any{"code": err.Error()})
}
