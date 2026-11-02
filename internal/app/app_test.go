package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pandalibrary/internal/config"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	t.Setenv("PANDA_AUTO_MIGRATE", "true")
	t.Setenv("PANDA_MIGRATE_BACKUP", "false")
	t.Setenv("PANDA_DROP_DIR", "")
	t.Setenv("PANDA_BASE_URL", "")
	t.Setenv("PANDA_TRUSTED_PROXIES", "")
	t.Setenv("PANDA_MAX_UPLOAD_MB", "")
	t.Setenv("PANDA_LOG_LEVEL", "")
	cfg, err := config.Parse([]string{"--data-dir", t.TempDir(), "--listen", "127.0.0.1:0"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestStartupMigratesAndCreatesRuntimeDirectories(t *testing.T) {
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
	var version int
	err = app.databases.Reader.QueryRow(
		"SELECT MAX(version_id) FROM goose_db_version WHERE is_applied = 1",
	).Scan(&version)
	if err != nil || version != 1 || !app.ready.Load() {
		t.Fatalf("migration version = %d, readiness = %v, error = %v", version, app.ready.Load(), err)
	}
	for _, directory := range []string{"files", "covers", "tmp", "backups", "drop"} {
		if info, err := os.Stat(filepath.Join(cfg.DataDir, directory)); err != nil || !info.IsDir() {
			t.Fatalf("runtime directory %s: %v", directory, err)
		}
	}
}

func TestMigrationFailureClosesDatabaseBeforeListen(t *testing.T) {
	cfg := testConfig(t)
	t.Setenv("PANDA_AUTO_MIGRATE", "false")
	called := false
	err := run(context.Background(), cfg, testLogger(), func(string, string) (net.Listener, error) {
		called = true
		return nil, errors.New("listener must not be opened")
	})
	if err == nil || !strings.Contains(err.Error(), "run startup migrations") || called {
		t.Fatalf("run error = %v, listener called = %v", err, called)
	}
	path := filepath.Join(cfg.DataDir, "pandalibrary.db")
	if err := os.Rename(path, path+".closed"); err != nil {
		t.Fatalf("database could not be renamed after failed startup: %v", err)
	}
}

func TestServeHealthAndGracefulShutdown(t *testing.T) {
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
	startedJob := make(chan struct{})
	stoppedJob := make(chan struct{})
	if err := app.scheduler.Register("test", time.Millisecond, func(ctx context.Context) error {
		close(startedJob)
		<-ctx.Done()
		close(stoppedJob)
		return ctx.Err()
	}); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- app.serve(ctx, listener) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := Healthcheck(context.Background(), listener.Addr().String()); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("server did not become healthy")
		}
		time.Sleep(10 * time.Millisecond)
	}
	response, err := http.Get("http://" + listener.Addr().String() + "/books/42")
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || response.StatusCode != http.StatusOK ||
		!strings.Contains(string(body), `<script nonce="`) ||
		!strings.Contains(response.Header.Get("Content-Security-Policy"), "'nonce-") {
		t.Fatalf("embedded SPA = %d, read %v, close %v, CSP %q", response.StatusCode,
			readErr, closeErr, response.Header.Get("Content-Security-Policy"))
	}
	select {
	case <-startedJob:
	case <-time.After(5 * time.Second):
		t.Fatal("scheduler job did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not shut down")
	}
	select {
	case <-stoppedJob:
	default:
		t.Fatal("scheduler was not stopped")
	}
	if app.ready.Load() {
		t.Fatal("application remained ready after shutdown")
	}
	if err := Healthcheck(context.Background(), listener.Addr().String()); err == nil {
		t.Fatal("healthcheck succeeded after shutdown")
	}
}

func TestGracefulShutdownWaitsForInFlightRequest(t *testing.T) {
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
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseRequest := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseRequest()
	app.handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		if _, err := w.Write([]byte("finished")); err != nil {
			t.Errorf("write response: %v", err)
		}
	})
	listener, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serveDone := make(chan error, 1)
	go func() { serveDone <- app.serve(ctx, listener) }()
	requestDone := make(chan error, 1)
	go func() {
		response, err := http.Get("http://" + listener.Addr().String())
		if err != nil {
			requestDone <- err
			return
		}
		body, readErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if readErr != nil || closeErr != nil || string(body) != "finished" {
			requestDone <- fmt.Errorf("response body %q, read %v, close %v", body, readErr, closeErr)
			return
		}
		requestDone <- nil
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	deadline := time.Now().Add(5 * time.Second)
	for app.ready.Load() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if app.ready.Load() {
		t.Fatal("server did not begin shutdown")
	}
	select {
	case err := <-serveDone:
		t.Fatalf("server exited before request completed: %v", err)
	default:
	}
	releaseRequest()
	select {
	case err := <-requestDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("request did not finish")
	}
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not finish shutdown")
	}
}
