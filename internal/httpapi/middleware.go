package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"runtime/debug"
	"strings"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

const contentSecurityPolicy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; " +
	"media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob:; " +
	"object-src 'none'; base-uri 'self'; frame-ancestors 'none'"

type contextKey uint8

const (
	requestIDKey contextKey = iota
	clientIPKey
	requestSchemeKey
)

// Middleware is a composable HTTP middleware.
type Middleware func(http.Handler) http.Handler

// RequestID returns the server-generated ID for the request.
func RequestID(r *http.Request) string {
	value, _ := r.Context().Value(requestIDKey).(string)
	return value
}

// ClientIP returns the client address resolved through trusted proxies.
func ClientIP(r *http.Request) string {
	value, _ := r.Context().Value(clientIPKey).(string)
	return value
}

// RequestScheme returns the request scheme resolved through trusted proxies.
func RequestScheme(r *http.Request) string {
	value, _ := r.Context().Value(requestSchemeKey).(string)
	return value
}

func requestIDMiddleware(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var random [16]byte
			if _, err := rand.Read(random[:]); err != nil {
				logger.Error("generate request ID", "error", err)
				WriteProblem(w, logger, http.StatusInternalServerError, "")
				return
			}
			id := hex.EncodeToString(random[:])
			w.Header().Set("X-Request-ID", id)
			ctx := context.WithValue(r.Context(), requestIDKey, id)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func loggingMiddleware(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			writer := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			defer func() {
				status := writer.Status()
				if status == 0 {
					status = http.StatusOK
				}
				logger.Info("HTTP request",
					"request_id", RequestID(r), "method", r.Method, "path", r.URL.Path,
					"client_ip", ClientIP(r), "status", status, "bytes", writer.BytesWritten(),
					"duration", time.Since(start))
			}()
			next.ServeHTTP(writer, r)
		})
	}
}

func recoveryMiddleware(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if recovered := recover(); recovered != nil {
					logger.Error("HTTP handler panic", "request_id", RequestID(r),
						"panic_type", fmt.Sprintf("%T", recovered), "stack", string(debug.Stack()))
					if writer, ok := w.(middleware.WrapResponseWriter); ok && writer.Status() != 0 {
						return
					}
					WriteProblem(w, logger, http.StatusInternalServerError, "")
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

func realIPMiddleware(logger *slog.Logger, proxies []netip.Prefix) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			peer, err := parseRemoteIP(r.RemoteAddr)
			client := peer
			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}
			if err != nil {
				logger.Warn("invalid remote address", "error", err)
			} else if isTrusted(peer, proxies) {
				if forwarded := r.Header.Values("X-Forwarded-For"); len(forwarded) > 0 {
					if resolved, err := forwardedClient(peer, strings.Join(forwarded, ","), proxies); err != nil {
						logger.Warn("invalid forwarded client address", "peer", peer.String(), "error", err)
					} else {
						client = resolved
					}
				}
				if forwarded := r.Header.Values("X-Forwarded-Proto"); len(forwarded) > 0 {
					if len(forwarded) == 1 && (forwarded[0] == "http" || forwarded[0] == "https") {
						scheme = forwarded[0]
					} else {
						logger.Warn("invalid forwarded request scheme", "peer", peer.String())
					}
				}
			}
			r.Header = r.Header.Clone()
			r.Header.Del("X-Forwarded-For")
			r.Header.Del("X-Forwarded-Proto")
			r.Header.Del("X-Real-IP")
			r.Header.Del("Forwarded")
			clientText := r.RemoteAddr
			if client.IsValid() {
				clientText = client.Unmap().String()
				r.RemoteAddr = clientText
			}
			ctx := context.WithValue(r.Context(), clientIPKey, clientText)
			ctx = context.WithValue(ctx, requestSchemeKey, scheme)
			*r = *r.WithContext(ctx)
			next.ServeHTTP(w, r)
		})
	}
}

func parseRemoteIP(address string) (netip.Addr, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	return netip.ParseAddr(host)
}

func isTrusted(address netip.Addr, proxies []netip.Prefix) bool {
	for _, prefix := range proxies {
		if prefix.Contains(address) || prefix.Contains(address.Unmap()) {
			return true
		}
	}
	return false
}

func forwardedClient(peer netip.Addr, value string, proxies []netip.Prefix) (netip.Addr, error) {
	client := peer
	entries := strings.Split(value, ",")
	for i := len(entries) - 1; i >= 0 && isTrusted(client, proxies); i-- {
		address, err := netip.ParseAddr(strings.TrimSpace(entries[i]))
		if err != nil {
			return netip.Addr{}, errors.New("X-Forwarded-For contains an invalid address")
		}
		client = address
	}
	return client, nil
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func bodyLimitMiddleware(logger *slog.Logger, limit int64) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.ContentLength > limit {
				WriteProblem(w, logger, http.StatusRequestEntityTooLarge, "")
				return
			}
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, limit)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// CookieProtection protects unsafe requests to cookie-authenticated route groups.
func CookieProtection(baseURL *url.URL, logger *slog.Logger) (Middleware, error) {
	protection := http.NewCrossOriginProtection()
	if baseURL != nil {
		origin := (&url.URL{Scheme: baseURL.Scheme, Host: baseURL.Host}).String()
		if err := protection.AddTrustedOrigin(origin); err != nil {
			return nil, err
		}
	}
	protection.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteProblem(w, logger, http.StatusForbidden, "")
	}))
	return protection.Handler, nil
}
