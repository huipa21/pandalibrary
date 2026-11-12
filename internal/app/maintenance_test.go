package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestMaintenanceIsRegisteredBeforeServing(t *testing.T) {
	cfg := testConfig(t)
	app, err := newApplication(context.Background(), cfg, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := app.close(); err != nil {
			t.Error(err)
		}
	}()
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		path := "/api/v1/admin/maintenance"
		if method == http.MethodPost {
			path += "/backup"
		}
		response := httptest.NewRecorder()
		app.handler.ServeHTTP(response, httptest.NewRequest(method, path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s = %d, want authenticated maintenance route", method, path, response.Code)
		}
	}
	entries, err := os.ReadDir(filepath.Join(cfg.DataDir, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != ".application.lock" {
			t.Fatal("maintenance ran before the scheduler started")
		}
	}
	if len(app.maintenance.Jobs()) != 7 {
		t.Fatalf("supported jobs = %d", len(app.maintenance.Jobs()))
	}
	for _, job := range app.maintenance.Jobs() {
		if job.Status != "idle" || job.LastRun != nil {
			t.Fatalf("job started during application construction: %+v", job)
		}
	}
	for _, route := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/me/annotation-assets"},
		{http.MethodGet, "/api/v1/me/annotation-assets/" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
	} {
		response := httptest.NewRecorder()
		app.handler.ServeHTTP(response, httptest.NewRequest(route.method, route.path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("unmounted asset route: %s %s = %d", route.method, route.path, response.Code)
		}
	}
}
