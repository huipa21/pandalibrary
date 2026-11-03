package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"
	"unicode/utf8"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/kosync"
	"pandalibrary/internal/reading"

	"github.com/go-chi/chi/v5"
)

type kosyncHTTP struct {
	service *kosync.Service
	auth    *auth.Service
	logger  *slog.Logger
	limiter *auth.RateLimiter
}

// KOSyncMount registers the header-authenticated KOReader protocol, not cookie APIs.
func KOSyncMount(service *kosync.Service, authentication *auth.Service, logger *slog.Logger) Mount {
	h := &kosyncHTTP{service: service, auth: authentication, logger: logger, limiter: auth.NewRateLimiter()}
	return func(router chi.Router, _ Middleware) {
		router.Route("/kosync", func(r chi.Router) {
			r.Get("/healthcheck", func(w http.ResponseWriter, _ *http.Request) {
				h.json(w, http.StatusOK, map[string]string{"state": "OK"})
			})
			r.Post("/users/create", func(w http.ResponseWriter, _ *http.Request) {
				h.protocolError(w, http.StatusPaymentRequired, 2005, "User registration is disabled.")
			})
			r.Get("/users/auth", func(w http.ResponseWriter, r *http.Request) {
				if _, ok := h.authenticate(w, r); ok {
					h.json(w, http.StatusOK, map[string]string{"authorized": "OK"})
				}
			})
			r.Put("/syncs/progress", h.put)
			r.Get("/syncs/progress/{document}", h.get)
			r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
				h.protocolError(w, http.StatusNotFound, 404, "Not found")
			})
			r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
				h.protocolError(w, http.StatusMethodNotAllowed, 405, "Method not allowed")
			})
		})
	}
}

func (h *kosyncHTTP) authenticate(w http.ResponseWriter, r *http.Request) (reading.Viewer, bool) {
	if !h.limiter.Allow(ClientIP(r), time.Now()) {
		w.Header().Set("Retry-After", "600")
		h.protocolError(w, http.StatusTooManyRequests, 2001, "Unauthorized")
		return reading.Viewer{}, false
	}
	if len(r.Header.Values("X-Auth-User")) != 1 || len(r.Header.Values("X-Auth-Key")) != 1 ||
		r.Header.Get("X-Auth-User") == "" || len(r.Header.Get("X-Auth-User")) > 128 {
		h.protocolError(w, http.StatusUnauthorized, 2001, "Unauthorized")
		return reading.Viewer{}, false
	}
	user, err := h.auth.VerifyAppPassword(r.Context(), r.Header.Get("X-Auth-User"), "kosync", r.Header.Get("X-Auth-Key"))
	if err != nil {
		if errors.Is(err, auth.ErrInvalidCredentials) {
			h.protocolError(w, http.StatusUnauthorized, 2001, "Unauthorized")
		} else {
			h.writeError(w, r, err)
		}
		return reading.Viewer{}, false
	}
	h.limiter.Reset(ClientIP(r))
	return reading.Viewer{UserID: user.ID, IsAdmin: user.Role == "admin"}, true
}

func (h *kosyncHTTP) put(w http.ResponseWriter, r *http.Request) {
	viewer, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, kosync.MaxRequestBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			h.protocolError(w, http.StatusRequestEntityTooLarge, 2003, "Invalid request")
		} else {
			h.logger.Warn("read KOReader request", "error", err)
			h.protocolError(w, http.StatusBadRequest, 103, "Invalid JSON.")
		}
		return
	}
	if !utf8.Valid(raw) || !json.Valid(raw) {
		h.protocolError(w, http.StatusBadRequest, 103, "Invalid JSON.")
		return
	}
	var input *kosync.Input
	if err := json.Unmarshal(raw, &input); err != nil || input == nil {
		h.protocolError(w, http.StatusForbidden, 2003, "Invalid request")
		return
	}
	record, err := h.service.Put(r.Context(), viewer, *input)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.json(w, http.StatusOK, struct {
		Document  string  `json:"document"`
		Timestamp float64 `json:"timestamp"`
	}{record.Document, record.Timestamp})
}

func (h *kosyncHTTP) get(w http.ResponseWriter, r *http.Request) {
	viewer, ok := h.authenticate(w, r)
	if !ok {
		return
	}
	record, err := h.service.Get(r.Context(), viewer, chi.URLParam(r, "document"))
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	if record == nil {
		h.json(w, http.StatusOK, struct{}{})
		return
	}
	h.json(w, http.StatusOK, record)
}

func (h *kosyncHTTP) writeError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, kosync.ErrDocument):
		h.protocolError(w, http.StatusForbidden, 2004, "Field 'document' not provided.")
	case errors.Is(err, kosync.ErrDocumentNotServable):
		h.protocolError(w, http.StatusForbidden, 2007, "Field 'document' contains characters the read route cannot serve.")
	case errors.Is(err, kosync.ErrInvalid):
		h.protocolError(w, http.StatusForbidden, 2003, "Invalid request")
	default:
		h.logger.Error("KOReader sync failed", "method", r.Method, "error", err)
		h.protocolError(w, http.StatusBadGateway, 2000, "Unknown server error.")
	}
}

func (h *kosyncHTTP) protocolError(w http.ResponseWriter, status, code int, message string) {
	h.json(w, status, struct {
		Message string `json:"message"`
		Code    int    `json:"code"`
	}{message, code})
}

func (h *kosyncHTTP) json(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		h.logger.Error("write KOReader response", "error", err)
	}
}
