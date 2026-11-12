package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/backup"

	"github.com/go-chi/chi/v5"
)

type backupHTTP struct {
	service *backup.Service
	logger  *slog.Logger
}

// BackupMount registers the full-data archive API (separate from DB maintenance).
func BackupMount(service *backup.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	h := &backupHTTP{service, logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(admin chi.Router) {
			admin.Use(SessionMiddleware(authentication, logger))
			admin.Use(RequireRole("admin", logger))
			admin.Get("/api/v1/admin/backups", h.list)
			admin.Get("/api/v1/admin/backups/{name}", h.download)
			admin.With(cookieProtection).Post("/api/v1/admin/backups", h.create)
			admin.With(cookieProtection).Post("/api/v1/admin/backups/restore", h.restore)
		})
	}
}

func (h *backupHTTP) respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		h.logger.Error("write backup response", "error", err)
	}
}

func (h *backupHTTP) failure(w http.ResponseWriter, r *http.Request, err error) {
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		WriteProblem(w, h.logger, http.StatusRequestEntityTooLarge, "The backup exceeds the request size limit.")
	case errors.Is(err, backup.ErrPending):
		WriteProblem(w, h.logger, http.StatusConflict, "A restore is already staged. Restart the server to apply it.")
	case errors.Is(err, backup.ErrInvalid):
		h.logger.Warn("backup validation failed", "request_id", RequestID(r), "error", err)
		WriteProblem(w, h.logger, http.StatusBadRequest, "Invalid, damaged, oversized, or incompatible backup archive.")
	case errors.Is(err, backup.ErrNotFound):
		WriteProblem(w, h.logger, http.StatusNotFound, "Backup not found.")
	default:
		h.logger.Error("backup operation failed", "request_id", RequestID(r), "error", err)
		WriteProblem(w, h.logger, http.StatusInternalServerError, "Backup operation failed; check server logs.")
	}
}

func (h *backupHTTP) list(w http.ResponseWriter, r *http.Request) {
	items, err := h.service.List()
	if err != nil {
		h.failure(w, r, err)
		return
	}
	pending, err := h.service.PendingStatus()
	if err != nil {
		h.failure(w, r, err)
		return
	}
	h.respond(w, http.StatusOK, map[string]any{
		"backups": items, "restore_pending": pending,
		"restart_required":  pending,
		"max_archive_bytes": backup.MaxArchiveBytes,
	})
}

func (h *backupHTTP) create(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	info, err := h.service.Create(ctx)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	h.respond(w, http.StatusCreated, map[string]any{"backup": info})
}

func (h *backupHTTP) download(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	file, err := h.service.Open(name)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	defer func() {
		if err := file.Close(); err != nil {
			h.logger.Error("close backup download", "error", err)
		}
	}()
	stat, err := file.Stat()
	if err != nil {
		h.failure(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	http.ServeContent(w, r, name, stat.ModTime(), file)
}

func (h *backupHTTP) restore(w http.ResponseWriter, r *http.Request) {
	kind, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		WriteProblem(w, h.logger, http.StatusBadRequest, "Expected application/json or multipart/form-data.")
		return
	}
	var input io.Reader
	var closeInput func()
	switch kind {
	case "application/json":
		var body struct {
			Name    string `json:"name"`
			Confirm bool   `json:"confirm"`
		}
		decoder := json.NewDecoder(io.LimitReader(r.Body, 4097))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil || !body.Confirm || body.Name == "" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Supply {\"name\":\"full-…tar.gz\",\"confirm\":true}.")
			return
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Expected one JSON object.")
			return
		}
		file, err := h.service.Open(body.Name)
		if err != nil {
			h.failure(w, r, err)
			return
		}
		input = file
		closeInput = func() {
			if err := file.Close(); err != nil {
				h.logger.Error("close restore source", "error", err)
			}
		}
	case "multipart/form-data":
		// Stream parts: ParseMultipartForm could spool private archives into the
		// host's temporary directory. Confirmation must precede the file.
		reader, err := r.MultipartReader()
		if err != nil {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Invalid multipart upload.")
			return
		}
		confirm, err := reader.NextPart()
		if err != nil {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Send confirm=true before file.")
			return
		}
		value, readErr := io.ReadAll(io.LimitReader(confirm, 6))
		if confirm.FormName() != "confirm" || readErr != nil || strings.TrimSpace(string(value)) != "true" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Send confirm=true before file.")
			return
		}
		part, err := reader.NextPart()
		if err != nil || part.FormName() != "file" || part.FileName() == "" {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Expected a file part.")
			return
		}
		input = part
		closeInput = func() {
			if err := part.Close(); err != nil {
				h.logger.Error("close restore upload", "error", err)
			}
		}
	default:
		WriteProblem(w, h.logger, http.StatusUnsupportedMediaType, "Expected application/json or multipart/form-data.")
		return
	}
	defer closeInput()
	if err := h.service.Stage(r.Context(), input); err != nil {
		h.failure(w, r, err)
		return
	}
	h.respond(w, http.StatusAccepted, map[string]any{
		"status": "staged", "restart_required": true, "restore_pending": true,
		"message":   "Archive validated and staged. Restart PandaLibrary to replace all app data. Changes made before restart will be discarded.",
		"staged_at": time.Now().UTC(),
	})
}
