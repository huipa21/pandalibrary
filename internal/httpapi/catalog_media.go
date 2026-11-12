package httpapi

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
	"unicode"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/covers"
)

func (h *catalogHTTP) serveBookFile(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	bookID, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	fileID, ok := h.pathID(w, r, "fileID")
	if !ok {
		return
	}
	values, ok := h.query(w, r, "v")
	if !ok {
		return
	}
	content, err := h.service.OpenBookFile(r.Context(), viewer, bookID, fileID, values.Get("v"))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.serveContent(w, r, content, true)
}

func (h *catalogHTTP) serveCover(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	bookID, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	values, ok := h.query(w, r, "w")
	if !ok {
		return
	}
	thumbnail := false
	if width := values.Get("w"); width != "" {
		if width != "400" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "The cover width is unsupported.")
			return
		}
		thumbnail = true
	}
	content, err := h.service.OpenCover(r.Context(), viewer, bookID, thumbnail)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.serveContent(w, r, content, false)
}

func (h *catalogHTTP) serveContent(w http.ResponseWriter, r *http.Request, content catalog.Content, download bool) {
	defer func() {
		if err := content.File.Close(); err != nil {
			h.logger.Error("close catalog content", "request_id", RequestID(r), "error", err)
		}
	}()
	w.Header().Add("Vary", "Cookie")
	w.Header().Set("Cache-Control", "private, no-cache")
	if content.Immutable {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	}
	w.Header().Set("Content-Type", content.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("ETag", `"`+content.ETag+`"`)
	if download {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
			"filename": safeDownloadName(content.Filename),
		}))
	}
	modTime := content.ModTime
	if !content.Immutable {
		// Mutable URLs need ETags: timestamps can collide across replacements.
		modTime = time.Time{}
	}
	http.ServeContent(w, r, content.Filename, modTime, content.File)
}

func safeDownloadName(name string) string {
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." || name == "/" {
		return "book"
	}
	return name
}

func (h *catalogHTTP) updateCover(w http.ResponseWriter, r *http.Request, viewer catalog.Viewer) {
	bookID, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	values, ok := h.query(w, r, "source")
	if !ok {
		return
	}
	source := values.Get("source")
	if source == "" {
		source = "upload"
	}
	if source != "upload" {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The cover source is invalid.")
		return
	}
	if err := h.service.CheckVisible(r.Context(), viewer, bookID); err != nil {
		h.writeError(w, r, err)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "image/jpeg" && mediaType != "image/png" &&
		mediaType != "image/gif" && mediaType != "image/webp" {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The cover content type is unsupported.")
		return
	}
	if r.ContentLength > covers.MaxInputBytes {
		WriteProblem(w, h.logger, http.StatusRequestEntityTooLarge, "")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, covers.MaxInputBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			WriteProblem(w, h.logger, http.StatusRequestEntityTooLarge, "")
		} else {
			h.logger.Warn("read cover request", "request_id", RequestID(r), "error", err)
			WriteProblem(w, h.logger, http.StatusBadRequest, "The cover request body could not be read.")
		}
		return
	}
	result, err := h.service.UpdateCover(r.Context(), viewer, bookID, source, body)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeJSON(w, http.StatusOK, result)
}
