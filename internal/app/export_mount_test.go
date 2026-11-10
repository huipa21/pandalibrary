package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNotesExportRouteIsMountedInApplication(t *testing.T) {
	application, err := newApplication(context.Background(), testConfig(t), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := application.close(); err != nil {
			t.Error(err)
		}
	})
	for _, path := range []string{"/api/v1/me/notes?limit=50", "/api/v1/me/notes/export?book_ids=1"} {
		response := httptest.NewRecorder()
		application.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("notes route %s = %d %s, want authenticated API route",
				path, response.Code, response.Body.String())
		}
	}
}
