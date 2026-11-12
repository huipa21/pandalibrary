package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"pandalibrary/internal/backup"
)

func TestStartupAppliesRestoreOnlyAfterPreviousApplicationStops(t *testing.T) {
	ctx := context.Background()
	cfg := testConfig(t)
	first, err := newApplication(ctx, cfg, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.databases.Writer.Exec(`INSERT INTO users (username,password_hash,role,locale,created_at,updated_at) VALUES ('original','hash','admin','en',1,1)`); err != nil {
		first.close()
		t.Fatal(err)
	}
	media := filepath.Join(cfg.DataDir, "assets", "example")
	if err := os.WriteFile(media, []byte("original image"), 0o600); err != nil {
		first.close()
		t.Fatal(err)
	}
	service, err := backup.New(cfg, first.databases.Writer, nil)
	if err != nil {
		first.close()
		t.Fatal(err)
	}
	snapshot, err := service.Create(ctx)
	if err != nil {
		first.close()
		t.Fatal(err)
	}
	file, err := service.Open(snapshot.Name)
	if err != nil {
		first.close()
		t.Fatal(err)
	}
	err = service.Stage(ctx, file)
	file.Close()
	if err != nil {
		first.close()
		t.Fatal(err)
	}
	if _, err := first.databases.Writer.Exec(`UPDATE users SET username='changed'`); err != nil {
		first.close()
		t.Fatal(err)
	}
	if err := os.WriteFile(media, []byte("changed"), 0o600); err != nil {
		first.close()
		t.Fatal(err)
	}
	if second, err := newApplication(ctx, cfg, testLogger()); err == nil {
		second.close()
		first.close()
		t.Fatal("startup restored while another application held its data lock")
	}
	if err := first.close(); err != nil {
		t.Fatal(err)
	}
	second, err := newApplication(ctx, cfg, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := second.close(); err != nil {
			t.Error(err)
		}
	}()
	var username string
	if err := second.databases.Reader.QueryRow("SELECT username FROM users").Scan(&username); err != nil || username != "original" {
		t.Fatalf("restored database = %s, %v", username, err)
	}
	content, err := os.ReadFile(media)
	if err != nil || string(content) != "original image" {
		t.Fatalf("restored assets = %s, %v", content, err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/backups", nil)
	response := httptest.NewRecorder()
	second.handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("backup route not mounted with authentication: %d", response.Code)
	}
}
