package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/backup"
	"pandalibrary/internal/config"

	"github.com/go-chi/chi/v5"
)

func TestBackupsAdminAPIAndStagedRestore(t *testing.T) {
	ctx := context.Background()
	databases := openHTTPTestDatabase(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authentication, err := auth.NewService(ctx, databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(".", ".backup-http-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	for _, root := range []string{"files", "covers", "assets", "tmp", "bookheap", "drop"} {
		if err := os.MkdirAll(filepath.Join(dir, root), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	service, err := backup.New(config.Config{DataDir: dir}, databases.Writer, &sync.RWMutex{})
	if err != nil {
		t.Fatal(err)
	}
	cookies := map[string]*http.Cookie{}
	for i, role := range []string{"admin", "user"} {
		if _, err := databases.Writer.Exec(`INSERT INTO users (id,username,password_hash,role,locale,created_at,updated_at) VALUES (?,?,'test',?,'en',1,1)`, i+1, role, role); err != nil {
			t.Fatal(err)
		}
		token := strings.Repeat(string(rune('a'+i)), 43)
		hash := sha256.Sum256([]byte(token))
		now := time.Now().UnixMilli()
		if _, err := databases.Writer.Exec(`INSERT INTO sessions (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)`, hash[:], i+1, now, now+3600000, now); err != nil {
			t.Fatal(err)
		}
		cookies[role] = &http.Cookie{Name: sessionCookieName, Value: token}
	}
	router := chi.NewRouter()
	protection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	BackupMount(service, authentication, logger)(router, protection)
	base := "/api/v1/admin/backups"
	for _, route := range []struct{ method, path string }{
		{"GET", base}, {"POST", base}, {"GET", base + "/full-test.tar.gz"}, {"POST", base + "/restore"},
	} {
		requireProblem(t, authRequest(t, router, route.method, route.path, nil, nil), http.StatusUnauthorized)
		requireProblem(t, authRequest(t, router, route.method, route.path, nil, cookies["user"]), http.StatusForbidden)
	}
	for _, path := range []string{base, base + "/restore"} {
		request := httptest.NewRequest(http.MethodPost, path, nil)
		request.AddCookie(cookies["admin"])
		request.Header.Set("Origin", "https://evil.example")
		request.Header.Set("Sec-Fetch-Site", "cross-site")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		requireProblem(t, response, http.StatusForbidden)
	}
	created := authRequest(t, router, http.MethodPost, base, nil, cookies["admin"])
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	var body struct {
		Backup backup.Info `json:"backup"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil || body.Backup.SizeBytes <= 0 {
		t.Fatalf("create response = %s, %v", created.Body.String(), err)
	}
	list := authRequest(t, router, http.MethodGet, base, nil, cookies["admin"])
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), body.Backup.Name) ||
		!strings.Contains(list.Body.String(), `"restore_pending":false`) {
		t.Fatalf("list = %d %s", list.Code, list.Body.String())
	}
	download := authRequest(t, router, http.MethodGet, base+"/"+body.Backup.Name, nil, cookies["admin"])
	if download.Code != http.StatusOK || download.Header().Get("Content-Type") != "application/gzip" ||
		!strings.Contains(download.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("download = %d %s", download.Code, download.Body.String())
	}
	requireProblem(t, authRequest(t, router, http.MethodGet, base+"/full-missing.tar.gz", nil, cookies["admin"]), http.StatusNotFound)
	requireProblem(t, authRequest(t, router, http.MethodPost, base+"/restore", map[string]any{
		"name": body.Backup.Name, "confirm": false,
	}, cookies["admin"]), http.StatusBadRequest)
	restored := authRequest(t, router, http.MethodPost, base+"/restore", map[string]any{
		"name": body.Backup.Name, "confirm": true,
	}, cookies["admin"])
	if restored.Code != http.StatusAccepted || !strings.Contains(restored.Body.String(), `"restart_required":true`) ||
		!strings.Contains(restored.Body.String(), `"status":"staged"`) {
		t.Fatalf("restore = %d %s", restored.Code, restored.Body.String())
	}
	requireProblem(t, authRequest(t, router, http.MethodPost, base+"/restore", map[string]any{
		"name": body.Backup.Name, "confirm": true,
	}, cookies["admin"]), http.StatusConflict)
	pending := filepath.Join(service.DataDir, "backups", ".pending-restore.tar.gz")
	if err := os.Remove(pending); err != nil {
		t.Fatal(err)
	}
	for _, valid := range []bool{false, true} {
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		if err := writer.WriteField("confirm", "true"); err != nil {
			t.Fatal(err)
		}
		part, err := writer.CreateFormFile("file", "backup.tar.gz")
		if err != nil {
			t.Fatal(err)
		}
		if valid {
			_, err = part.Write(download.Body.Bytes())
		} else {
			_, err = part.Write([]byte("invalid"))
		}
		if err := errors.Join(err, writer.Close()); err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, base+"/restore", &buffer)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		request.AddCookie(cookies["admin"])
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		expected := http.StatusBadRequest
		if valid {
			expected = http.StatusAccepted
		}
		if response.Code != expected {
			t.Fatalf("upload valid=%v: %d %s", valid, response.Code, response.Body.String())
		}
	}
	list = authRequest(t, router, http.MethodGet, base, nil, cookies["admin"])
	if !strings.Contains(list.Body.String(), `"restart_required":true`) {
		t.Fatalf("pending restore not reported: %s", list.Body.String())
	}
}
