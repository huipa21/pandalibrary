package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"unicode/utf8"

	"pandalibrary/internal/auth"

	"github.com/go-chi/chi/v5"
)

// AdminUsersMount exposes account lifecycle routes only to live browser-session admins.
func AdminUsersMount(service *auth.Service, logger *slog.Logger) Mount {
	handler := &adminUsersHTTP{service: service, logger: logger}
	return func(router chi.Router, cookieProtection Middleware) {
		router.Group(func(secured chi.Router) {
			secured.Use(SessionMiddleware(service, logger), RequireRole("admin", logger))
			secured.Get("/api/v1/admin/users", handler.list)
			secured.Get("/api/v1/admin/users/{id}", handler.get)
			secured.With(cookieProtection).Post("/api/v1/admin/users", handler.create)
			secured.With(cookieProtection).Patch("/api/v1/admin/users/{id}", handler.update)
			secured.With(cookieProtection).Delete("/api/v1/admin/users/{id}", handler.delete)
			secured.With(cookieProtection).Post("/api/v1/admin/users/{id}/reset-password", handler.reset)
			secured.With(cookieProtection).Post("/api/v1/admin/users/{id}/revoke-credentials", handler.revoke)
		})
	}
}

type adminUsersHTTP struct {
	service *auth.Service
	logger  *slog.Logger
}

func adminSessionToken(r *http.Request) string {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func (h *adminUsersHTTP) list(w http.ResponseWriter, r *http.Request) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The query is invalid.")
		return
	}
	for key, entries := range values {
		if (key != "limit" && key != "cursor" && key != "q" && key != "category") || len(entries) != 1 {
			WriteProblem(w, h.logger, http.StatusBadRequest, "The query is invalid.")
			return
		}
	}
	limit := 50
	if values.Has("limit") {
		limit, err = strconv.Atoi(values.Get("limit"))
		if err != nil || limit < 1 || limit > 100 {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Limit must be between 1 and 100.")
			return
		}
	}
	result, err := h.service.AdminSearchUsers(r.Context(), adminSessionToken(r), limit, values.Get("cursor"), values.Get("q"), values.Get("category"))
	h.respond(w, r, http.StatusOK, result, err)
}

func (h *adminUsersHTTP) id(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id < 1 {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The user ID must be positive.")
		return 0, false
	}
	return id, true
}

func (h *adminUsersHTTP) get(w http.ResponseWriter, r *http.Request) {
	id, ok := h.id(w, r)
	if !ok {
		return
	}
	user, err := h.service.AdminGetUser(r.Context(), adminSessionToken(r), id)
	h.respond(w, r, http.StatusOK, map[string]auth.AdminUser{"user": user}, err)
}

type adminCreateUserRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	Role        string `json:"role"`
	Locale      string `json:"locale"`
}

func (h *adminUsersHTTP) create(w http.ResponseWriter, r *http.Request) {
	var request adminCreateUserRequest
	if !h.decode(w, r, &request) {
		return
	}
	user, err := h.service.AdminCreateUser(r.Context(), adminSessionToken(r), auth.CreateUserInput{
		Username: request.Username, DisplayName: request.DisplayName, Password: request.Password,
		Role: request.Role, Locale: request.Locale,
	})
	h.respond(w, r, http.StatusCreated, map[string]auth.AdminUser{"user": user}, err)
}

func (h *adminUsersHTTP) update(w http.ResponseWriter, r *http.Request) {
	id, ok := h.id(w, r)
	if !ok {
		return
	}
	var patch auth.AdminUserPatch
	if !h.decode(w, r, &patch) {
		return
	}
	user, err := h.service.AdminUpdateUser(r.Context(), adminSessionToken(r), id, patch)
	h.respond(w, r, http.StatusOK, map[string]auth.AdminUser{"user": user}, err)
}

func (h *adminUsersHTTP) delete(w http.ResponseWriter, r *http.Request) {
	id, ok := h.id(w, r)
	if !ok {
		return
	}
	err := h.service.AdminDeleteUser(r.Context(), adminSessionToken(r), id)
	h.respond(w, r, http.StatusOK, map[string]bool{"deleted": true}, err)
}

func (h *adminUsersHTTP) reset(w http.ResponseWriter, r *http.Request) {
	id, ok := h.id(w, r)
	if !ok {
		return
	}
	var request struct {
		Password string `json:"password"`
	}
	if !h.decode(w, r, &request) {
		return
	}
	err := h.service.AdminResetPassword(r.Context(), adminSessionToken(r), id, request.Password)
	h.credentialsResponse(w, r, id, "reset", err)
}

func (h *adminUsersHTTP) revoke(w http.ResponseWriter, r *http.Request) {
	id, ok := h.id(w, r)
	if !ok {
		return
	}
	var request struct{}
	if !h.decode(w, r, &request) {
		return
	}
	err := h.service.AdminRevokeCredentials(r.Context(), adminSessionToken(r), id)
	h.credentialsResponse(w, r, id, "revoked", err)
}

func (h *adminUsersHTTP) credentialsResponse(w http.ResponseWriter, r *http.Request, id int64, key string, err error) {
	viewer, _ := ViewerFromRequest(r)
	if err == nil && viewer.ID == id {
		clearSessionCookie(w, h.service.SecureCookie())
	}
	h.respond(w, r, http.StatusOK, map[string]bool{key: true}, err)
}

func (h *adminUsersHTTP) decode(w http.ResponseWriter, r *http.Request, target any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16*1024))
	if err != nil {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The request body is invalid or exceeds 16 KiB.")
		return false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil || !utf8.Valid(raw) {
		WriteProblem(w, h.logger, http.StatusBadRequest, "The request body must be an object.")
		return false
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			WriteProblem(w, h.logger, http.StatusBadRequest, "Fields must not be null; omit unchanged fields.")
			return false
		}
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	return decodeAuthJSON(w, r, h.logger, target)
}

func (h *adminUsersHTTP) respond(w http.ResponseWriter, r *http.Request, status int, value any, err error) {
	switch {
	case err == nil:
		writeAuthJSON(w, h.logger, status, value)
	case errors.Is(err, auth.ErrInvalidSession):
		WriteProblem(w, h.logger, http.StatusUnauthorized, "")
	case errors.Is(err, auth.ErrAdminRequired):
		WriteProblem(w, h.logger, http.StatusForbidden, "")
	case errors.Is(err, auth.ErrUserNotFound):
		WriteProblem(w, h.logger, http.StatusNotFound, "The user was not found.")
	case errors.Is(err, auth.ErrProtectedAccount):
		WriteProblem(w, h.logger, http.StatusConflict, err.Error())
	default:
		writeAuthError(w, r, h.logger, err, false)
	}
}
