package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/jobs"

	"github.com/go-chi/chi/v5"
)

func TestMaintenanceAdminStatusAndRuns(t *testing.T) {
	ctx := context.Background()
	databases := openHTTPTestDatabase(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authentication, err := auth.NewService(ctx, databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	blobs, err := blobstore.New(root)
	if err != nil {
		t.Fatal(err)
	}
	maintenance, err := jobs.NewMaintenance(ctx, databases.Writer, databases.Reader, blobs, root, filepath.Join(root, "drop"), logger)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := jobs.NewScheduler(logger)
	if err != nil {
		t.Fatal(err)
	}
	if err := maintenance.Register(scheduler); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := maintenance.Stop(stopCtx); err != nil {
			t.Errorf("stop maintenance service: %v", err)
		}
	})
	tokens := map[string]string{"admin": strings.Repeat("a", 43), "user": strings.Repeat("b", 43)}
	for index, account := range []struct {
		username string
		role     string
	}{
		{username: "admin", role: "admin"},
		{username: "user", role: "user"},
	} {
		if _, err := databases.Writer.ExecContext(ctx, `
			INSERT INTO users (id, username, password_hash, role, locale, created_at, updated_at)
			VALUES (?, ?, 'test', ?, 'en', 1, 1)
		`, index+1, account.username, account.role); err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256([]byte(tokens[account.role]))
		userID := index + 1
		if _, err := databases.Writer.ExecContext(ctx, `
			INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
			VALUES (?, ?, ?, ?, ?)
		`, hash[:], userID, time.Now().UnixMilli(), time.Now().Add(time.Hour).UnixMilli(), time.Now().UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	router := chi.NewRouter()
	cookieProtection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	AuthMount(authentication, logger)(router, cookieProtection)
	MaintenanceMount(maintenance, authentication, logger)(router, cookieProtection)

	requireProblem(t, authRequest(t, router, http.MethodGet, "/api/v1/admin/maintenance", nil, nil), http.StatusUnauthorized)
	userCookie := &http.Cookie{Name: sessionCookieName, Value: tokens["user"]}
	requireProblem(t, authRequest(t, router, http.MethodGet, "/api/v1/admin/maintenance", nil, userCookie), http.StatusForbidden)
	requireProblem(t, authRequest(t, router, http.MethodPost, "/api/v1/admin/maintenance/backup", nil, userCookie), http.StatusForbidden)
	adminCookie := &http.Cookie{Name: sessionCookieName, Value: tokens["admin"]}
	list := authRequest(t, router, http.MethodGet, "/api/v1/admin/maintenance", nil, adminCookie)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"name":"cleanup-expired"`) ||
		!strings.Contains(list.Body.String(), `"name":"wal-checkpoint"`) {
		t.Fatalf("maintenance list = %d %s", list.Code, list.Body.String())
	}
	var body struct {
		Jobs []jobs.JobStatus `json:"jobs"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &body); err != nil || len(body.Jobs) != 6 {
		t.Fatalf("job DTO = %+v, %v", body, err)
	}
	for _, job := range body.Jobs {
		if job.Status != "idle" || job.LastRun != nil || job.Schedule == "" {
			t.Fatalf("unexpected initial job DTO: %+v", job)
		}
	}
	crossOrigin := httptest.NewRequest(http.MethodPost, "/api/v1/admin/maintenance/backup", nil)
	crossOrigin.AddCookie(adminCookie)
	crossOrigin.Header.Set("Origin", "https://evil.example")
	crossOrigin.Header.Set("Sec-Fetch-Site", "cross-site")
	crossResponse := httptest.NewRecorder()
	router.ServeHTTP(crossResponse, crossOrigin)
	requireProblem(t, crossResponse, http.StatusForbidden)
	conn, err := databases.Writer.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	accepted := authRequest(t, router, http.MethodPost, "/api/v1/admin/maintenance/cleanup-expired", nil, adminCookie)
	if accepted.Code != http.StatusAccepted || !strings.Contains(accepted.Body.String(), `"status":"accepted"`) {
		_ = conn.Close()
		t.Fatalf("maintenance run acceptance = %d %s", accepted.Code, accepted.Body.String())
	}
	overlap := authRequest(t, router, http.MethodPost, "/api/v1/admin/maintenance/cleanup-expired", nil, adminCookie)
	requireProblem(t, overlap, http.StatusConflict)
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if strings.Contains(authRequest(t, router, http.MethodGet, "/api/v1/admin/maintenance", nil, adminCookie).Body.String(),
			`"status":"completed"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("completed run was not reported")
		}
		time.Sleep(10 * time.Millisecond)
	}
	unsupported := authRequest(t, router, http.MethodPost, "/api/v1/admin/maintenance/unknown", nil, adminCookie)
	requireProblem(t, unsupported, http.StatusNotFound)
	if _, err := databases.Writer.Exec(`DROP TABLE books_fts`); err != nil {
		t.Fatal(err)
	}
	failed := authRequest(t, router, http.MethodPost, "/api/v1/admin/maintenance/fts-check", nil, adminCookie)
	if failed.Code != http.StatusAccepted {
		t.Fatalf("FTS run acceptance = %d %s", failed.Code, failed.Body.String())
	}
	deadline = time.Now().Add(5 * time.Second)
	for {
		response := authRequest(t, router, http.MethodGet, "/api/v1/admin/maintenance", nil, adminCookie)
		if strings.Contains(response.Body.String(), `"status":"error"`) {
			if strings.Contains(response.Body.String(), "books_fts") || strings.Contains(response.Body.String(), root) {
				t.Fatalf("maintenance error exposed internal information: %s", response.Body.String())
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("failed run was not reported")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := maintenance.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	requireProblem(t, authRequest(t, router, http.MethodPost, "/api/v1/admin/maintenance/backup", nil, adminCookie), http.StatusServiceUnavailable)
}
