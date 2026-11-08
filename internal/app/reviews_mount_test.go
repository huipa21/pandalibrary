package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReviewRoutesAreMountedWithSessionAuthentication(t *testing.T) {
	application, err := newApplication(t.Context(), testConfig(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := application.close(); err != nil {
			t.Error(err)
		}
	})
	for _, route := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/books/1/reviews"},
		{http.MethodPut, "/api/v1/books/1/reviews/me"},
		{http.MethodDelete, "/api/v1/books/1/reviews/me"},
		{http.MethodDelete, "/api/v1/books/1/reviews/1"},
	} {
		response := httptest.NewRecorder()
		application.handler.ServeHTTP(response, httptest.NewRequest(route.method, route.path, strings.NewReader(`{"body":"review"}`)))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: %d %s", route.method, route.path, response.Code, response.Body)
		}
	}
}
