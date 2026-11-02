package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"pandalibrary/internal/auth"

	"github.com/go-chi/chi/v5"
)

const sessionCookieName = "pl_session"

type viewerContextKey struct{}

// ViewerFromRequest returns the authenticated viewer installed by SessionMiddleware.
func ViewerFromRequest(r *http.Request) (auth.User, bool) {
	viewer, ok := r.Context().Value(viewerContextKey{}).(auth.User)
	return viewer, ok
}

// SessionMiddleware resolves the session cookie and installs the authenticated viewer.
func SessionMiddleware(service *auth.Service, logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cookie, err := r.Cookie(sessionCookieName)
			if err != nil {
				WriteProblem(w, logger, http.StatusUnauthorized, "")
				return
			}
			viewer, err := service.Authenticate(r.Context(), cookie.Value)
			if errors.Is(err, auth.ErrInvalidSession) {
				WriteProblem(w, logger, http.StatusUnauthorized, "")
				return
			}
			if err != nil {
				logger.Error("authenticate browser session", "request_id", RequestID(r), "error", err)
				WriteProblem(w, logger, http.StatusInternalServerError, "")
				return
			}
			ctx := context.WithValue(r.Context(), viewerContextKey{}, viewer)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequireRole rejects requests whose authenticated viewer does not have the requested role.
func RequireRole(role string, logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			viewer, ok := ViewerFromRequest(r)
			if !ok {
				WriteProblem(w, logger, http.StatusUnauthorized, "")
				return
			}
			if viewer.Role != role {
				WriteProblem(w, logger, http.StatusForbidden, "")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// AuthMount mounts first-run setup, browser-session, profile, and app-password routes.
func AuthMount(service *auth.Service, logger *slog.Logger) Mount {
	return func(router chi.Router, cookieProtection Middleware) {
		router.Route("/api/v1", func(api chi.Router) {
			api.Get("/setup", func(w http.ResponseWriter, r *http.Request) {
				required, err := service.SetupRequired(r.Context())
				if err != nil {
					logger.Error("check first-run setup state", "request_id", RequestID(r), "error", err)
					WriteProblem(w, logger, http.StatusInternalServerError, "")
					return
				}
				writeAuthJSON(w, logger, http.StatusOK, map[string]bool{"required": required})
			})
			api.With(cookieProtection, setupRateLimit(service, logger)).Post("/setup", func(w http.ResponseWriter, r *http.Request) {
				var request setupRequest
				if !decodeAuthJSON(w, r, logger, &request) {
					return
				}
				user, err := service.CreateInitialAdmin(r.Context(), request.Token, auth.CreateUserInput{
					Username: request.Username, DisplayName: request.DisplayName,
					Password: request.Password, Role: "admin", Locale: request.Locale,
				})
				if err != nil {
					writeAuthError(w, r, logger, err, true)
					return
				}
				session, err := service.Login(r.Context(), request.Username, request.Password,
					r.UserAgent(), ClientIP(r))
				if err != nil {
					logger.Error("create initial administrator session", "request_id", RequestID(r), "error", err)
					WriteProblem(w, logger, http.StatusInternalServerError, "")
					return
				}
				setSessionCookie(w, session, service.SecureCookie())
				writeAuthJSON(w, logger, http.StatusCreated, map[string]auth.User{"user": user})
			})
			api.With(cookieProtection, loginRateLimit(service, logger)).Post("/auth/login", func(w http.ResponseWriter, r *http.Request) {
				var request loginRequest
				if !decodeAuthJSON(w, r, logger, &request) {
					return
				}
				session, err := service.Login(r.Context(), request.Username, request.Password, r.UserAgent(), ClientIP(r))
				if errors.Is(err, auth.ErrInvalidCredentials) {
					WriteProblem(w, logger, http.StatusUnauthorized, "The username or password is incorrect.")
					return
				}
				if err != nil {
					logger.Error("log in user", "request_id", RequestID(r), "error", err)
					WriteProblem(w, logger, http.StatusInternalServerError, "")
					return
				}
				service.ResetLoginAttempts(ClientIP(r))
				setSessionCookie(w, session, service.SecureCookie())
				writeAuthJSON(w, logger, http.StatusOK, map[string]auth.User{"user": session.User})
			})
			api.With(cookieProtection).Post("/auth/logout", func(w http.ResponseWriter, r *http.Request) {
				var token string
				if cookie, err := r.Cookie(sessionCookieName); err == nil {
					token = cookie.Value
				}
				if err := service.Logout(r.Context(), token); err != nil {
					logger.Error("log out user", "request_id", RequestID(r), "error", err)
					WriteProblem(w, logger, http.StatusInternalServerError, "")
					return
				}
				clearSessionCookie(w, service.SecureCookie())
				writeAuthJSON(w, logger, http.StatusOK, map[string]bool{"logged_out": true})
			})

			api.Group(func(secured chi.Router) {
				secured.Use(SessionMiddleware(service, logger))
				secured.Get("/auth/me", func(w http.ResponseWriter, r *http.Request) {
					viewer, _ := ViewerFromRequest(r)
					writeAuthJSON(w, logger, http.StatusOK, map[string]auth.User{"user": viewer})
				})
				secured.Get("/me/profile", func(w http.ResponseWriter, r *http.Request) {
					viewer, _ := ViewerFromRequest(r)
					writeAuthJSON(w, logger, http.StatusOK, map[string]auth.User{"user": viewer})
				})
				secured.With(cookieProtection).Patch("/me/profile", func(w http.ResponseWriter, r *http.Request) {
					var request profileRequest
					if !decodeAuthJSON(w, r, logger, &request) {
						return
					}
					viewer, _ := ViewerFromRequest(r)
					if err := service.UpdateProfile(r.Context(), viewer.ID, request.DisplayName, request.Locale); err != nil {
						writeAuthError(w, r, logger, err, false)
						return
					}
					viewer.DisplayName = strings.TrimSpace(request.DisplayName)
					viewer.Locale = request.Locale
					writeAuthJSON(w, logger, http.StatusOK, map[string]auth.User{"user": viewer})
				})
				secured.Get("/me/app-passwords", func(w http.ResponseWriter, r *http.Request) {
					viewer, _ := ViewerFromRequest(r)
					passwords, err := service.ListAppPasswords(r.Context(), viewer.ID)
					if err != nil {
						logger.Error("list app passwords", "request_id", RequestID(r), "error", err)
						WriteProblem(w, logger, http.StatusInternalServerError, "")
						return
					}
					writeAuthJSON(w, logger, http.StatusOK, map[string]any{"app_passwords": passwords})
				})
				secured.With(cookieProtection).Post("/me/app-passwords", func(w http.ResponseWriter, r *http.Request) {
					var request appPasswordRequest
					if !decodeAuthJSON(w, r, logger, &request) {
						return
					}
					viewer, _ := ViewerFromRequest(r)
					password, err := service.CreateAppPassword(r.Context(), viewer.ID, request.Kind, request.Label)
					if err != nil {
						writeAuthError(w, r, logger, err, false)
						return
					}
					writeAuthJSON(w, logger, http.StatusCreated, map[string]auth.AppPassword{"app_password": password})
				})
				secured.With(cookieProtection).Delete("/me/app-passwords/{id}", func(w http.ResponseWriter, r *http.Request) {
					id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
					if err != nil || id < 1 {
						WriteProblem(w, logger, http.StatusBadRequest, "The app password ID is invalid.")
						return
					}
					viewer, _ := ViewerFromRequest(r)
					if err := service.RevokeAppPassword(r.Context(), viewer.ID, id); err != nil {
						writeAuthError(w, r, logger, err, false)
						return
					}
					writeAuthJSON(w, logger, http.StatusOK, map[string]bool{"revoked": true})
				})
			})
		})
	}
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type setupRequest struct {
	Token       string `json:"token"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Password    string `json:"password"`
	Locale      string `json:"locale"`
}

type profileRequest struct {
	DisplayName string `json:"display_name"`
	Locale      string `json:"locale"`
}

type appPasswordRequest struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
}

func loginRateLimit(service *auth.Service, logger *slog.Logger) Middleware {
	return rateLimit(service.AllowLoginAttempt, logger)
}

func setupRateLimit(service *auth.Service, logger *slog.Logger) Middleware {
	return rateLimit(service.AllowSetupAttempt, logger)
}

func rateLimit(allow func(string) bool, logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !allow(ClientIP(r)) {
				w.Header().Set("Retry-After", "600")
				WriteProblem(w, logger, http.StatusTooManyRequests, "Too many attempts. Try again later.")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func decodeAuthJSON(w http.ResponseWriter, r *http.Request, logger *slog.Logger, target any) bool {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		WriteProblem(w, logger, http.StatusBadRequest, "The request body is invalid.")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		WriteProblem(w, logger, http.StatusBadRequest, "The request body must contain one JSON value.")
		return false
	}
	return true
}

func writeAuthJSON(w http.ResponseWriter, logger *slog.Logger, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		logger.Error("write authentication response", "error", err)
	}
}

func writeAuthError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, err error, setup bool) {
	switch {
	case errors.Is(err, auth.ErrInvalidSetupToken):
		WriteProblem(w, logger, http.StatusUnauthorized, "The setup token is invalid or expired.")
	case errors.Is(err, auth.ErrSetupComplete):
		WriteProblem(w, logger, http.StatusConflict, "Initial setup has already been completed.")
	case errors.Is(err, auth.ErrUsernameTaken):
		WriteProblem(w, logger, http.StatusConflict, "That username is already in use.")
	case errors.Is(err, auth.ErrInvalidUser):
		WriteProblem(w, logger, http.StatusBadRequest, err.Error())
	case errors.Is(err, auth.ErrAppPasswordMissing):
		WriteProblem(w, logger, http.StatusNotFound, "The app password was not found.")
	default:
		logger.Error("authentication request failed", "request_id", RequestID(r), "error", err, "setup", setup)
		WriteProblem(w, logger, http.StatusInternalServerError, "")
	}
}

func setSessionCookie(w http.ResponseWriter, session auth.Session, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: session.Token, Path: "/", HttpOnly: true,
		Secure: secure, SameSite: http.SameSiteLaxMode, Expires: session.ExpiresAt,
	})
}

func clearSessionCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookieName, Value: "", Path: "/", HttpOnly: true, Secure: secure,
		SameSite: http.SameSiteLaxMode, Expires: time.Unix(1, 0), MaxAge: -1,
	})
}
