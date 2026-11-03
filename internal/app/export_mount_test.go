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
	response := httptest.NewRecorder()
	application.handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodGet, "/api/v1/me/notes/export?book_ids=1", nil,
	))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("notes export route = %d %s, want authenticated API route",
			response.Code, response.Body.String())
	}
}
