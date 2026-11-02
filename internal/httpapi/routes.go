package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Mount registers a domain's routes; cookieProtection is for session-authenticated groups.
type Mount func(router chi.Router, cookieProtection Middleware)

// RouterOptions provides the shared infrastructure needed by HTTP routes.
type RouterOptions struct {
	Database       *sql.DB
	Ready          func() bool
	Assets         fs.FS
	Logger         *slog.Logger
	TrustedProxies []netip.Prefix
	MaxBodyBytes   int64
	BaseURL        *url.URL
	Mounts         []Mount
}

// NewRouter creates the health, extension, and embedded SPA routes.
func NewRouter(options RouterOptions) (http.Handler, error) {
	if options.Database == nil || options.Ready == nil || options.Assets == nil ||
		options.Logger == nil || options.MaxBodyBytes <= 0 {
		return nil, errors.New("router requires a database, readiness check, assets, logger, and positive body limit")
	}
	spa, err := newSPAHandler(options.Assets, options.Logger)
	if err != nil {
		return nil, err
	}
	cookieProtection, err := CookieProtection(options.BaseURL, options.Logger)
	if err != nil {
		return nil, fmt.Errorf("configure cookie origin protection: %w", err)
	}
	router := chi.NewRouter()
	router.Use(requestIDMiddleware(options.Logger))
	router.Use(loggingMiddleware(options.Logger))
	router.Use(recoveryMiddleware(options.Logger))
	router.Use(realIPMiddleware(options.Logger, options.TrustedProxies))
	router.Use(securityHeadersMiddleware)
	router.Use(bodyLimitMiddleware(options.Logger, options.MaxBodyBytes))
	router.Get("/healthz", healthHandler(options))
	for _, mount := range options.Mounts {
		if mount == nil {
			return nil, errors.New("route mount must not be nil")
		}
		mount(router, cookieProtection)
	}
	methodSet := make(map[string]struct{})
	if err := chi.Walk(router, func(method, _ string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		methodSet[method] = struct{}{}
		return nil
	}); err != nil {
		return nil, fmt.Errorf("inspect HTTP routes: %w", err)
	}
	methods := make([]string, 0, len(methodSet))
	for method := range methodSet {
		methods = append(methods, method)
	}
	sort.Strings(methods)
	router.NotFound(spa.ServeHTTP)
	router.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if r.URL.RawPath != "" {
			path = r.URL.RawPath
		}
		var allowed []string
		for _, method := range methods {
			if router.Match(chi.NewRouteContext(), method, path) {
				allowed = append(allowed, method)
			}
		}
		if len(allowed) > 0 {
			w.Header().Set("Allow", strings.Join(allowed, ", "))
		}
		WriteProblem(w, options.Logger, http.StatusMethodNotAllowed, "")
	})
	return router, nil
}

func healthHandler(options RouterOptions) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !options.Ready() {
			WriteProblem(w, options.Logger, http.StatusServiceUnavailable, "")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := options.Database.PingContext(ctx); err != nil {
			options.Logger.Error("health check database ping failed", "error", err)
			WriteProblem(w, options.Logger, http.StatusServiceUnavailable, "")
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte("ok\n")); err != nil {
			options.Logger.Error("write health response", "error", err)
		}
	}
}
