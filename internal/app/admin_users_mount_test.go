package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAdminUsersRoutesMountedInApplication(t *testing.T) {
	application, err := newApplication(t.Context(), testConfig(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := application.close(); err != nil {
			t.Error(err)
		}
	})
	for _, endpoint := range []struct{ method, path string }{
		{"GET", "/api/v1/admin/users"},
		{"POST", "/api/v1/admin/users"},
		{"GET", "/api/v1/admin/users/1"},
		{"PATCH", "/api/v1/admin/users/1"},
		{"DELETE", "/api/v1/admin/users/1"},
		{"POST", "/api/v1/admin/users/1/reset-password"},
		{"POST", "/api/v1/admin/users/1/revoke-credentials"},
	} {
		response := httptest.NewRecorder()
		application.handler.ServeHTTP(response, httptest.NewRequest(endpoint.method, endpoint.path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Errorf("%s %s = %d %s, want authenticated API route", endpoint.method, endpoint.path, response.Code, response.Body)
		}
	}
}
