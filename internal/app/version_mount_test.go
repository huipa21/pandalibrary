package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"pandalibrary/internal/buildinfo"
)

func TestVersionRouteIsMountedPublicly(t *testing.T) {
	application, err := newApplication(t.Context(), testConfig(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := application.close(); err != nil {
			t.Error(err)
		}
	})
	response := httptest.NewRecorder()
	application.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/version", nil))
	expected, err := buildinfo.Current()
	if errors.Is(err, buildinfo.ErrUnavailable) {
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("unavailable version route = %d %s", response.Code, response.Body)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	var actual buildinfo.Info
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &actual) != nil ||
		!reflect.DeepEqual(actual, expected) {
		t.Fatalf("public version route = %d %s, expected %+v", response.Code, response.Body, expected)
	}
}
