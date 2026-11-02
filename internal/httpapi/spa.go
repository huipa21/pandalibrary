package httpapi

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"golang.org/x/net/html"
)

type spaHandler struct {
	assets        fs.FS
	indexSegments [][]byte
	logger        *slog.Logger
}

func newSPAHandler(assets fs.FS, logger *slog.Logger) (*spaHandler, error) {
	index, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		return nil, fmt.Errorf("read embedded SPA fallback: %w", err)
	}
	segments, err := splitIndexForNonces(index)
	if err != nil {
		return nil, fmt.Errorf("prepare embedded SPA fallback: %w", err)
	}
	return &spaHandler{assets: assets, indexSegments: segments, logger: logger}, nil
}

// Preserve the generated HTML bytes while adding a fresh nonce to each script tag.
func splitIndexForNonces(index []byte) ([][]byte, error) {
	tokenizer := html.NewTokenizer(bytes.NewReader(index))
	var segments [][]byte
	var current bytes.Buffer
	for {
		tokenType := tokenizer.Next()
		if tokenType == html.ErrorToken {
			if err := tokenizer.Err(); !errors.Is(err, io.EOF) {
				return nil, err
			}
			break
		}
		raw := bytes.Clone(tokenizer.Raw())
		if tokenType == html.StartTagToken || tokenType == html.SelfClosingTagToken {
			token := tokenizer.Token()
			if token.Data == "script" {
				for _, attr := range token.Attr {
					if attr.Key == "nonce" {
						return nil, errors.New("embedded script already has a nonce attribute")
					}
				}
				end := len(raw) - 1
				if end < 0 || raw[end] != '>' {
					return nil, errors.New("invalid embedded script tag")
				}
				if end > 0 && raw[end-1] == '/' {
					end--
				}
				current.Write(raw[:end])
				current.WriteString(` nonce="`)
				segments = append(segments, bytes.Clone(current.Bytes()))
				current.Reset()
				current.WriteByte('"')
				current.Write(raw[end:])
				continue
			}
		}
		current.Write(raw)
	}
	segments = append(segments, bytes.Clone(current.Bytes()))
	return segments, nil
}

func (s *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if reservedPath(r.URL.Path) {
		WriteProblem(w, s.logger, http.StatusNotFound, "")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		WriteProblem(w, s.logger, http.StatusMethodNotAllowed, "")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" || name == "index.html" {
		s.serveIndex(w, r)
		return
	}
	trailingSlash := strings.HasSuffix(name, "/")
	if trailingSlash {
		name = strings.TrimRight(name, "/")
	}
	if name == "" {
		s.serveIndex(w, r)
		return
	}
	if !fs.ValidPath(name) {
		WriteProblem(w, s.logger, http.StatusNotFound, "")
		return
	}
	if trailingSlash {
		if name == "_app" || strings.HasPrefix(name, "_app/") {
			WriteProblem(w, s.logger, http.StatusNotFound, "")
		} else {
			s.serveIndex(w, r)
		}
		return
	}
	file, err := s.assets.Open(name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			if name == "_app" || strings.HasPrefix(name, "_app/") {
				WriteProblem(w, s.logger, http.StatusNotFound, "")
			} else {
				s.serveIndex(w, r)
			}
		} else {
			s.logger.Error("open embedded SPA asset", "path", name, "error", err)
			WriteProblem(w, s.logger, http.StatusInternalServerError, "")
		}
		return
	}
	defer func() {
		if err := file.Close(); err != nil {
			s.logger.Error("close embedded SPA asset", "path", name, "error", err)
		}
	}()
	info, err := file.Stat()
	if err != nil {
		s.logger.Error("stat embedded SPA asset", "path", name, "error", err)
		WriteProblem(w, s.logger, http.StatusInternalServerError, "")
		return
	}
	if info.IsDir() {
		if name == "_app" || strings.HasPrefix(name, "_app/") {
			WriteProblem(w, s.logger, http.StatusNotFound, "")
		} else {
			s.serveIndex(w, r)
		}
		return
	}
	reader, ok := file.(io.ReadSeeker)
	if !ok {
		s.logger.Error("embedded SPA asset is not seekable", "path", name)
		WriteProblem(w, s.logger, http.StatusInternalServerError, "")
		return
	}
	if strings.HasPrefix(name, "_app/immutable/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), reader)
}

func (s *spaHandler) serveIndex(w http.ResponseWriter, r *http.Request) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		s.logger.Error("generate SPA CSP nonce", "error", err)
		WriteProblem(w, s.logger, http.StatusInternalServerError, "")
		return
	}
	nonce := base64.StdEncoding.EncodeToString(random[:])
	var page bytes.Buffer
	for i, segment := range s.indexSegments {
		if i > 0 {
			page.WriteString(nonce)
		}
		page.Write(segment)
	}
	policy := strings.Replace(contentSecurityPolicy,
		"script-src 'self' 'wasm-unsafe-eval';",
		"script-src 'self' 'wasm-unsafe-eval' 'nonce-"+nonce+"';", 1)
	w.Header().Set("Content-Security-Policy", policy)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(page.Bytes()))
}

func reservedPath(path string) bool {
	for _, prefix := range []string{"/api", "/opds", "/kosync"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}
