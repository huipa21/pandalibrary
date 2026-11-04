package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"pandalibrary/internal/buildinfo"

	"github.com/go-chi/chi/v5"
)

func TestVersionMountPublicReadOnlyDTO(t *testing.T) {
	info, err := buildinfo.New(buildinfo.Stamp{
		Commit: "0123456789abcdef0123456789abcdef01234567", CommitDate: "2026-01-01T00:30:45+09:30",
		Dirty: "true", Release: "v1.2.3",
	})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := chi.NewRouter()
	versionMount(info, nil, logger)(router, nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/version", nil))
	if response.Code != http.StatusOK ||
		response.Header().Get("Content-Type") != "application/json; charset=utf-8" ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("version response = %d %s, headers %v", response.Code, response.Body, response.Header())
	}
	var got buildinfo.Info
	decoder := json.NewDecoder(response.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&got); err != nil || !reflect.DeepEqual(got, info) {
		t.Fatalf("version DTO = %+v, want %+v: %v", got, info, err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		t.Fatalf("unexpected extra response: %v", err)
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(method, "/api/v1/version", nil))
		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d", method, response.Code)
		}
	}
}

func TestVersionMountUnavailableDoesNotExposeError(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	router := chi.NewRouter()
	versionMount(buildinfo.Info{}, errors.New("private path and credentials"), logger)(router, nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/version", nil))
	if response.Code != http.StatusServiceUnavailable || response.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(response.Body.String(), "Build version is unavailable.") ||
		strings.Contains(response.Body.String(), "private path") || strings.Contains(response.Body.String(), "credentials") {
		t.Fatalf("unavailable response = %d %s", response.Code, response.Body)
	}
}
