package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWordbookRoutesMounted(t *testing.T) {
	app, err := newApplication(context.Background(), testConfig(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := app.close(); err != nil {
			t.Error(err)
		}
	})
	for _, route := range []struct{ method, target string }{
		{http.MethodGet, "/api/v1/wordbooks"},
		{http.MethodPost, "/api/v1/wordbooks"},
		{http.MethodPatch, "/api/v1/wordbooks/1"},
		{http.MethodGet, "/api/v1/wordbooks/1/entries"},
		{http.MethodPost, "/api/v1/wordbooks/entries"},
		{http.MethodPatch, "/api/v1/wordbooks/1/entries/1"},
		{http.MethodDelete, "/api/v1/wordbooks/1/entries/1"},
		{http.MethodGet, "/api/v1/wordbooks/1/export"},
		{http.MethodPost, "/api/v1/wordbooks/1/import"},
	} {
		response := httptest.NewRecorder()
		app.handler.ServeHTTP(response, httptest.NewRequest(route.method, route.target, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s = %d %s", route.method, route.target, response.Code, response.Body.String())
		}
	}
}
