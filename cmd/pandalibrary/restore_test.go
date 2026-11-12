package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pandalibrary/internal/backup"
	"pandalibrary/internal/config"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

func TestLegacyDatabaseCommandsFailClearlyWhileServerOwnsLock(t *testing.T) {
	dir, err := os.MkdirTemp(".", ".legacy-lock-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	t.Setenv("PANDA_DATA_DIR", dir)
	lock, err := backup.Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := lock.Close(); err != nil {
			t.Error(err)
		}
	}()
	var output bytes.Buffer
	if err := runMigrate([]string{"status"}, &output); err == nil || !strings.Contains(err.Error(), "data directory is in use") {
		t.Fatalf("migrate lock error = %v", err)
	}
	prompt := func(string) (string, error) { return "correct horse battery", nil }
	if err := runUserWithPrompt([]string{"create", "--username", "admin", "--admin"}, &output, &output, prompt); err == nil ||
		!strings.Contains(err.Error(), "data directory is in use") {
		t.Fatalf("user lock error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "pandalibrary.db")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("CLI opened a database despite the application lock: %v", err)
	}
}

func TestRestoreCommandStagesOfflineAndRequiresConfirmation(t *testing.T) {
	dir, err := os.MkdirTemp(".", ".restore-cli-test-")
	if err != nil {
		t.Fatal(err)
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	for _, name := range []string{"PANDA_DROP_DIR", "PANDA_BOOKHEAP_DIR", "PANDA_BASE_URL", "PANDA_TRUSTED_PROXIES", "PANDA_MAX_UPLOAD_MB", "PANDA_LOG_LEVEL", "PANDA_DROP_POLL"} {
		t.Setenv(name, "")
	}
	t.Setenv("PANDA_AUTO_MIGRATE", "true")
	t.Setenv("PANDA_MIGRATE_BACKUP", "false")
	cfg, err := config.Parse([]string{"--data-dir", dir}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{"files", "covers", "assets", "tmp", "bookheap", "drop"} {
		if err := os.MkdirAll(filepath.Join(dir, root), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	filename := filepath.Join(dir, "pandalibrary.db")
	databases, err := db.Open(ctx, filename)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := migrations.NewRunner(databases.Writer, filename, migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		databases.Close()
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		databases.Close()
		t.Fatal(err)
	}
	service, err := backup.New(cfg, databases.Writer, nil)
	if err != nil {
		databases.Close()
		t.Fatal(err)
	}
	info, createErr := service.Create(ctx)
	if err := errors.Join(createErr, databases.Close()); err != nil {
		t.Fatal(err)
	}
	args := []string{"restore", "--file", filepath.Join(dir, "backups", info.Name), "--data-dir", dir}
	var stdout, stderr bytes.Buffer
	if err := run(args, &stdout, &stderr); err == nil {
		t.Fatal("restore accepted without confirmation")
	}
	lock, err := backup.Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	args = append(args, "--confirm")
	if err := run(args, &stdout, &stderr); err == nil || !strings.Contains(err.Error(), "in use") {
		lock.Close()
		t.Fatalf("restore ignored process lock: %v", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if err := run(args, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "Restart required") || !service.Pending() {
		t.Fatalf("restore output = %s; pending = %v", stdout.String(), service.Pending())
	}
}
