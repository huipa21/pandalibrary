package jobs

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

type maintenanceFixture struct {
	databases *db.DB
	service   *Maintenance
	dataDir   string
}

func newMaintenanceFixture(t *testing.T) *maintenanceFixture {
	t.Helper()
	dataDir := t.TempDir()
	path := filepath.Join(dataDir, "pandalibrary.db")
	databases, err := db.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close databases: %v", err)
		}
	})
	options := migrations.DefaultOptions()
	options.ReadEnvironment = false
	options.Backup = false
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), options)
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	blobs, err := blobstore.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewMaintenance(context.Background(), databases.Writer, databases.Reader, blobs, dataDir, filepath.Join(dataDir, "drop"), logger)
	if err != nil {
		t.Fatal(err)
	}
	scheduler, err := NewScheduler(logger)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Register(scheduler); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := service.Stop(ctx); err != nil {
			t.Errorf("stop maintenance service: %v", err)
		}
	})
	return &maintenanceFixture{databases: databases, service: service, dataDir: dataDir}
}

func seedUserAndLibrary(t *testing.T, database *sql.DB) {
	t.Helper()
	if _, err := database.Exec(`
		INSERT INTO users (id, username, password_hash, role, locale, created_at, updated_at)
		VALUES (1, 'admin', 'test', 'admin', 'en', 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`
		INSERT INTO libraries (id, name, slug, created_at, updated_at)
		VALUES (1, 'Library', 'library', 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
}

func TestMaintenanceRegistersExpectedSchedules(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	scheduler, err := NewScheduler(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewMaintenance(context.Background(), fixture.databases.Writer, fixture.databases.Reader, fixture.service.blobs, fixture.dataDir, filepath.Join(fixture.dataDir, "drop"), slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	defer service.cancel()
	if err := service.Register(scheduler); err != nil {
		t.Fatal(err)
	}
	if len(scheduler.jobs) != 6 {
		t.Fatalf("registered jobs = %d, want 6", len(scheduler.jobs))
	}
	got := make(map[string]time.Duration, len(scheduler.jobs))
	for _, job := range scheduler.jobs {
		got[job.name] = job.interval
	}
	want := map[string]time.Duration{
		"cleanup-expired": time.Hour, "backup": 24 * time.Hour, "orphan-sweep": 24 * time.Hour,
		"optimize": 24 * time.Hour, "fts-check": 24 * time.Hour, "wal-checkpoint": 5 * time.Minute,
	}
	for name, interval := range want {
		if got[name] != interval {
			t.Errorf("%s interval = %s, want %s", name, got[name], interval)
		}
	}
}

func TestCleanupExpiredBoundariesAndSyncInvariants(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	ctx := context.Background()
	seedUserAndLibrary(t, fixture.databases.Writer)
	now := time.Now().UTC().UnixMilli()
	old := now - int64((31 * 24 * time.Hour).Milliseconds())
	tombstone := now - int64((181 * 24 * time.Hour).Milliseconds())
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := fixture.databases.Writer.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.databases.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		VALUES (1, 1, 'Book', 'book', 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
	exec(`
		INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
		VALUES (zeroblob(32), 1, ?, ?, ?)
	`, now-1000, now-1, now-1000)
	exec(`
		INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
		VALUES (randomblob(32), 1, ?, ?, ?)
	`, now-1000, now+60_000, now-1000)
	exec(`INSERT INTO server_settings (key, value, updated_at) VALUES ('keep', '{}', 1)`)
	exec(`
		INSERT INTO metadata_cache (provider, request_key, status, schema_version, response, fetched_at, expires_at)
		VALUES ('openlibrary', 'expired', 404, 1, '{}', ?, ?)
	`, now-1000, now-1)
	exec(`
		INSERT INTO metadata_cache (provider, request_key, status, schema_version, response, fetched_at, expires_at)
		VALUES ('openlibrary', 'live', 404, 1, '{}', ?, ?)
	`, now-1000, now+60_000)
	exec(`
		INSERT INTO import_jobs (source, library_id, original_name, status, created_at)
		VALUES ('upload', 1, 'old.epub', 'failed', ?)
	`, old)
	exec(`
		INSERT INTO import_jobs (source, library_id, original_name, status, created_at)
		VALUES ('upload', 1, 'active.epub', 'processing', ?)
	`, old)
	exec(`
		INSERT INTO highlights (id, user_id, book_id, locator, created_at, updated_at, deleted_at, rev)
		VALUES ('00000000-0000-7000-8000-000000000001', 1, 1, '{}', ?, ?, ?, 8)
	`, tombstone, tombstone, tombstone)
	exec(`
		INSERT INTO notes (id, user_id, book_id, highlight_id, created_at, updated_at, deleted_at, rev)
		VALUES ('00000000-0000-7000-8000-000000000002', 1, 1,
			'00000000-0000-7000-8000-000000000001', ?, ?, ?, 9)
	`, tombstone, tombstone, tombstone)
	exec(`
		INSERT INTO bookmarks (id, user_id, book_id, locator, created_at, updated_at, deleted_at, rev)
		VALUES ('00000000-0000-7000-8000-000000000003', 1, 1, '{}', ?, ?, ?, 10),
		       ('00000000-0000-7000-8000-000000000004', 1, 1, '{}', ?, ?, NULL, 11)
	`, tombstone, tombstone, tombstone, now, now)
	exec(`INSERT INTO highlights_fts (rowid, text, user_id, book_id) VALUES (1, 'old text', 1, 1)`)
	exec(`INSERT INTO notes_fts (rowid, body, highlight_text, user_id, book_id) VALUES (1, 'old', 'old text', 1, 1)`)
	if err := fixture.service.cleanupExpired(ctx); err != nil {
		t.Fatal(err)
	}
	var expiredSessions, retainedSessions, expiredMetadata, retainedMetadata int
	var completedImports, activeImports, highlights, notes, bookmarks, searchRows, syncRevision int
	for _, check := range []struct {
		query string
		args  []any
		dest  *int
	}{
		{`SELECT count(*) FROM sessions WHERE expires_at <= ?`, []any{now}, &expiredSessions},
		{`SELECT count(*) FROM sessions WHERE expires_at > ?`, []any{now}, &retainedSessions},
		{`SELECT count(*) FROM metadata_cache WHERE request_key='expired'`, nil, &expiredMetadata},
		{`SELECT count(*) FROM metadata_cache WHERE request_key='live'`, nil, &retainedMetadata},
		{`SELECT count(*) FROM import_jobs WHERE status='failed'`, nil, &completedImports},
		{`SELECT count(*) FROM import_jobs WHERE status='processing'`, nil, &activeImports},
		{`SELECT count(*) FROM highlights`, nil, &highlights},
		{`SELECT count(*) FROM notes`, nil, &notes},
		{`SELECT count(*) FROM bookmarks`, nil, &bookmarks},
		{`SELECT (SELECT count(*) FROM highlights_fts) + (SELECT count(*) FROM notes_fts)`, nil, &searchRows},
		{`SELECT value FROM sync_counter WHERE id=1`, nil, &syncRevision},
	} {
		if err := fixture.databases.Reader.QueryRowContext(ctx, check.query, check.args...).Scan(check.dest); err != nil {
			t.Fatal(err)
		}
	}
	if expiredSessions != 0 || retainedSessions != 1 || expiredMetadata != 0 || retainedMetadata != 1 ||
		completedImports != 0 || activeImports != 1 || highlights != 0 || notes != 0 || bookmarks != 1 || searchRows != 0 || syncRevision != 0 {
		t.Fatalf("cleanup results: sessions=%d/%d metadata=%d/%d imports=%d/%d tombstones=%d/%d bookmarks=%d fts=%d rev=%d",
			expiredSessions, retainedSessions, expiredMetadata, retainedMetadata, completedImports,
			activeImports, highlights, notes, bookmarks, searchRows, syncRevision)
	}
}

func TestBackupRetentionVerificationAndFailure(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	if err := os.MkdirAll(filepath.Join(fixture.dataDir, "backups"), 0o750); err != nil {
		t.Fatal(err)
	}
	for i := range backupRetention {
		name := fmt.Sprintf("maintenance-20200101T000000.000000000Z-%016x.db", i)
		path := filepath.Join(fixture.dataDir, "backups", name)
		if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, time.Unix(int64(i), 0), time.Unix(int64(i), 0)); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.service.backup(context.Background()); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(fixture.dataDir, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != backupRetention {
		t.Fatalf("retained backups = %d, want %d", len(entries), backupRetention)
	}
	foundNew := false
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "maintenance-") {
			info, err := entry.Info()
			if err != nil {
				t.Fatal(err)
			}
			if info.Size() > 0 && !strings.Contains(entry.Name(), "20200101") {
				foundNew = true
				if err := verifyBackup(context.Background(), filepath.Join(fixture.dataDir, "backups", entry.Name())); err != nil {
					t.Fatalf("backup failed independent verification: %v", err)
				}
			}
		}
	}
	if !foundNew {
		t.Fatal("new verified backup was not retained")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := fixture.service.backup(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("backup with canceled context = %v", err)
	}
}

func TestOrphanSweepReferencesGraceSymlinkAndOutOfRoot(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	ctx := context.Background()
	seedUserAndLibrary(t, fixture.databases.Writer)
	hash := strings.Repeat("a", 64)
	coverHash := strings.Repeat("b", 64)
	_, err := fixture.databases.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, cover_sha256, created_at, updated_at)
		VALUES (1, 1, 'Book', 'book', ?, 1, 1)
	`, coverHash)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.databases.Writer.ExecContext(ctx, `
		INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
		VALUES (1, 1, ?, 'epub', 1, 'book.epub', 1)
	`, hash)
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range []string{
		filepath.Join("files", "aa"), filepath.Join("files", "cc"), filepath.Join("files", "dd"),
		filepath.Join("files", "ee"), filepath.Join("covers", "bb"), filepath.Join("covers", "ee"),
	} {
		if err := os.MkdirAll(filepath.Join(fixture.dataDir, directory), 0o750); err != nil {
			t.Fatal(err)
		}
	}
	referencedBook := filepath.Join(fixture.dataDir, "files", hash[:2], hash+".epub")
	oldOrphan := filepath.Join(fixture.dataDir, "files", "cc", strings.Repeat("c", 64)+".pdf")
	recentOrphan := filepath.Join(fixture.dataDir, "files", "dd", strings.Repeat("d", 64)+".pdf")
	referencedCover := filepath.Join(fixture.dataDir, "covers", coverHash[:2], coverHash+".jpg")
	oldCover := filepath.Join(fixture.dataDir, "covers", "ee", strings.Repeat("e", 64)+"-w400.jpg")
	for _, path := range []string{referencedBook, oldOrphan, recentOrphan, referencedCover, oldCover} {
		if err := os.WriteFile(path, []byte("blob"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-orphanGracePeriod - time.Hour)
	for _, path := range []string{referencedBook, oldOrphan, referencedCover, oldCover} {
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(fixture.dataDir, "files", "ee", strings.Repeat("e", 64)+".epub")
	symlinkCreated := os.Symlink(outside, symlink) == nil
	if err := fixture.service.sweepOrphans(ctx); err != nil {
		t.Fatal(err)
	}
	for path, wantPresent := range map[string]bool{
		referencedBook: true, oldOrphan: false, recentOrphan: true, referencedCover: true, oldCover: false,
		symlink: symlinkCreated, outside: true,
	} {
		_, err := os.Lstat(path)
		if (err == nil) != wantPresent {
			t.Errorf("%s exists = %v, want %v (err=%v)", path, err == nil, wantPresent, err)
		}
	}
}

func TestMaintenanceDatabaseChecks(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	ctx := context.Background()
	if err := fixture.service.checkpoint(ctx); err != nil {
		t.Fatalf("passive checkpoint: %v", err)
	}
	if err := fixture.service.optimize(ctx); err != nil {
		t.Fatalf("optimize: %v", err)
	}
	if err := fixture.service.checkFTS(ctx); err != nil {
		t.Fatalf("FTS consistency check: %v", err)
	}
	if _, err := fixture.databases.Writer.ExecContext(ctx, `DROP TABLE books_fts`); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.checkFTS(ctx); err == nil || !strings.Contains(err.Error(), "books_fts") {
		t.Fatalf("FTS inconsistency error = %v", err)
	}
}

func TestMaintenanceRunCancellationAndNoOverlap(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	started := make(chan struct{})
	fixture.service.jobs["cleanup-expired"].job.run = func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}
	run, err := fixture.service.RunNow("cleanup-expired")
	if err != nil || run.Status != "accepted" {
		t.Fatalf("RunNow = %+v, %v", run, err)
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("maintenance run did not start")
	}
	if _, err := fixture.service.RunNow("cleanup-expired"); !errors.Is(err, ErrJobRunning) {
		t.Fatalf("overlapping RunNow error = %v", err)
	}
	if err := fixture.service.runScheduled(context.Background(), "cleanup-expired"); err != nil {
		t.Fatalf("scheduled run should skip an overlapping manual run: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := fixture.service.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	status := fixture.service.Jobs()[0]
	for _, job := range fixture.service.Jobs() {
		if job.Name == "cleanup-expired" {
			status = job
		}
	}
	if status.Status != "error" || status.LastRun == nil || status.LastRun.CompletedAt == nil {
		t.Fatalf("canceled run status = %+v", status)
	}
	if _, err := fixture.service.RunNow("backup"); !errors.Is(err, ErrJobStopped) {
		t.Fatalf("RunNow after stop = %v", err)
	}
}

func TestCleanupExactBoundariesAndChildRetention(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	seedUserAndLibrary(t, fixture.databases.Writer)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := fixture.databases.Writer.ExecContext(ctx, statement, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		VALUES (1, 1, 'Book', 'book', 1, 1)`)
	exec(`UPDATE sync_counter SET value = 42 WHERE id = 1`)
	for _, offset := range []int64{-1, 0, 1} {
		exec(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
			VALUES (randomblob(32), 1, 1, ?, 1)`, now.UnixMilli()+offset)
		exec(`INSERT INTO metadata_cache (provider, request_key, status, schema_version, response, fetched_at, expires_at)
			VALUES ('openlibrary', ?, 200, 1, '{}', 1, ?)`, fmt.Sprint(offset), now.UnixMilli()+offset)
		exec(`INSERT INTO import_jobs (source, library_id, original_name, status, created_at)
			VALUES ('upload', 1, ?, 'imported', ?)`, fmt.Sprint(offset), now.Add(-importRetention).UnixMilli()+offset)
		exec(`INSERT INTO highlights (id, user_id, book_id, locator, created_at, updated_at, deleted_at, rev)
			VALUES (?, 1, 1, '{}', 1, 1, ?, 42)`,
			fmt.Sprintf("00000000-0000-7000-8000-%012d", offset+2), now.Add(-tombstoneRetention).UnixMilli()+offset)
	}
	// A newer child tombstone must survive the old parent's retention cutoff.
	exec(`INSERT INTO notes (id, user_id, book_id, highlight_id, created_at, updated_at, deleted_at, rev)
		VALUES ('00000000-0000-7000-8000-000000000004', 1, 1,
			'00000000-0000-7000-8000-000000000001', 1, 1, ?, 42)`, now.Add(-tombstoneRetention).UnixMilli())
	if err := fixture.service.cleanupExpiredAt(ctx, now); err != nil {
		t.Fatal(err)
	}
	for query, want := range map[string]int{
		`SELECT count(*) FROM sessions`:       1,
		`SELECT count(*) FROM metadata_cache`: 1,
		`SELECT count(*) FROM import_jobs`:    2,
		`SELECT count(*) FROM highlights`:     3,
		`SELECT count(*) FROM notes`:          1,
		`SELECT value FROM sync_counter`:      42,
	} {
		var got int
		if err := fixture.databases.Reader.QueryRowContext(ctx, query).Scan(&got); err != nil || got != want {
			t.Fatalf("%s = %d, want %d (err=%v)", query, got, want, err)
		}
	}
	if err := fixture.service.cleanupExpiredAt(ctx, now.Add(time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	var children, parents int
	if err := fixture.databases.Reader.QueryRow(`SELECT count(*) FROM notes`).Scan(&children); err != nil {
		t.Fatal(err)
	}
	if err := fixture.databases.Reader.QueryRow(`SELECT count(*) FROM highlights`).Scan(&parents); err != nil {
		t.Fatal(err)
	}
	if children != 0 || parents != 1 {
		t.Fatalf("after child expiry: children=%d parents=%d", children, parents)
	}
	rows, err := fixture.databases.Reader.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() || rows.Err() != nil {
		t.Fatal("cleanup violated referential integrity")
	}
}

func writeOldMaintenanceFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-orphanGracePeriod - time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
}

func TestOrphanSweepPreservesImportsSpoolAndConfiguredDrop(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	seedUserAndLibrary(t, fixture.databases.Writer)
	hash := strings.Repeat("a", 64)
	book := filepath.Join(fixture.dataDir, "files", "aa", hash+".epub")
	cover := filepath.Join(fixture.dataDir, "covers", "bb", strings.Repeat("b", 64)+".jpg")
	spool := filepath.Join(fixture.dataDir, "tmp", "book-token")
	manifest := filepath.Join(fixture.dataDir, "tmp", "imports", "1.json")
	drop := filepath.Join(fixture.dataDir, "drop", "book.epub")
	unknown := filepath.Join(fixture.dataDir, "files", "aa", hash+".unknown")
	for _, path := range []string{book, cover, spool, manifest, drop, unknown} {
		writeOldMaintenanceFile(t, path)
	}
	for _, status := range []string{"pending", "processing"} {
		if _, err := fixture.databases.Writer.Exec(`DELETE FROM import_jobs`); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.databases.Writer.Exec(`INSERT INTO import_jobs
			(source, library_id, original_name, sha256, status, created_at)
			VALUES ('upload', 1, 'book.epub', ?, ?, 1)`, hash, status); err != nil {
			t.Fatal(err)
		}
		if err := fixture.service.sweepOrphans(context.Background()); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{book, cover, spool, manifest, drop, unknown} {
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("sweep removed active or unmanaged file %s: %v", path, err)
			}
		}
	}
	if _, err := fixture.databases.Writer.Exec(`DELETE FROM import_jobs`); err != nil {
		t.Fatal(err)
	}
	fixture.service.dropDir = filepath.Join(fixture.dataDir, "files", "aa")
	if err := fixture.service.sweepOrphans(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(book); err != nil {
		t.Fatalf("sweep removed a book inside the configured drop directory: %v", err)
	}
}

func TestOrphanSweepKeepsBookheapCoversAndHonorsGuardedDirectories(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	coverHash := strings.Repeat("c", 64)
	bookHash := strings.Repeat("d", 64)
	cover := filepath.Join(fixture.dataDir, "covers", "cc", coverHash+".jpg")
	thumbnail := filepath.Join(fixture.dataDir, "covers", "cc", coverHash+"-w400.jpg")
	book := filepath.Join(fixture.dataDir, "files", "dd", bookHash+".epub")
	for _, path := range []string{cover, thumbnail, book} {
		writeOldMaintenanceFile(t, path)
	}
	if _, err := fixture.databases.Writer.Exec(`INSERT INTO bookheap_items
		(rel_path, file_name, size_bytes, mtime_ns, sha256, title, cover_sha256, source, status, created_at, updated_at)
		VALUES ('a.epub', 'a.epub', 1, 1, ?, 'A', ?, 'scan', 'ready', 1, 1)`, bookHash, coverHash); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.sweepOrphans(context.Background()); err != nil {
		t.Fatal(err)
	}
	for path, wantPresent := range map[string]bool{cover: true, thumbnail: true, book: false} {
		if _, err := os.Stat(path); (err == nil) != wantPresent {
			t.Errorf("%s exists = %v, want %v", path, err == nil, wantPresent)
		}
	}

	if _, err := fixture.databases.Writer.Exec(`DELETE FROM bookheap_items`); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.GuardDirectory(filepath.Join(fixture.dataDir, "covers", "cc")); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.sweepOrphans(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cover); err != nil {
		t.Fatalf("sweep removed a file inside a guarded directory: %v", err)
	}
}

func TestOrphanSweepDoesNotFollowShardSymlinks(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	outside := t.TempDir()
	path := filepath.Join(outside, strings.Repeat("a", 64)+".epub")
	writeOldMaintenanceFile(t, path)
	if err := os.MkdirAll(filepath.Join(fixture.dataDir, "files"), 0o750); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(fixture.dataDir, "files", "aa")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if err := fixture.service.sweepOrphans(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("sweep followed a shard symlink: %v", err)
	}
}

func TestBackupFailureDoesNotPruneAndQuotedDestination(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	fixture.service.dataDir = filepath.Join(fixture.dataDir, "quoted'data")
	if err := os.MkdirAll(fixture.service.dataDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.backup(context.Background()); err != nil {
		t.Fatalf("backup to a quoted destination: %v", err)
	}
	backupDir := filepath.Join(fixture.service.dataDir, "backups")
	for i := range 8 {
		name := fmt.Sprintf("maintenance-20200101T000000.000000000Z-%016x.db", i)
		if err := os.WriteFile(filepath.Join(backupDir, name), []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.databases.Writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.backup(context.Background()); err == nil {
		t.Fatal("backup unexpectedly succeeded with a closed database")
	}
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 9 {
		t.Fatalf("failed backup changed retention or left partial output: %d files", len(entries))
	}
}

func TestCleanupRetainsManifestAndHighestImportID(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	seedUserAndLibrary(t, fixture.databases.Writer)
	for range 3 {
		if _, err := fixture.databases.Writer.Exec(`INSERT INTO import_jobs
			(source, library_id, original_name, status, created_at)
			VALUES ('upload', 1, 'book.epub', 'failed', 1)`); err != nil {
			t.Fatal(err)
		}
	}

	writeOldMaintenanceFile(t, filepath.Join(fixture.dataDir, "tmp", "imports", "1.json"))
	if err := fixture.service.cleanupExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
	var ids string
	if err := fixture.databases.Reader.QueryRow(`SELECT group_concat(id) FROM import_jobs`).Scan(&ids); err != nil {
		t.Fatal(err)
	}
	if ids != "1,3" {
		t.Fatalf("retained import IDs = %q, want manifest job and high-water ID", ids)
	}
}

func TestMaintenanceRejectsUnregisteredAndCanceledWork(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	parent, cancel := context.WithCancel(context.Background())
	service, err := NewMaintenance(parent, fixture.databases.Writer, fixture.databases.Reader,
		fixture.service.blobs, fixture.dataDir, filepath.Join(fixture.dataDir, "drop"), slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	defer service.cancel()
	if _, err := service.RunNow("backup"); !errors.Is(err, ErrJobStopped) {
		t.Fatalf("run before registration = %v", err)
	}
	scheduler, err := NewScheduler(slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Register(scheduler); err != nil {
		t.Fatal(err)
	}
	called := false
	service.jobs["backup"].job.run = func(context.Context) error {
		called = true
		return nil
	}
	cancel()
	if err := service.runScheduled(context.Background(), "backup"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RunNow("backup"); !errors.Is(err, ErrJobStopped) {
		t.Fatalf("run after parent cancellation = %v", err)
	}
	if called {
		t.Fatal("job ran after parent cancellation")
	}
}

func TestMaintenanceReportsFTSIndexCorruption(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	if _, err := fixture.databases.Writer.Exec(`INSERT INTO books_fts(rowid, title) VALUES (1, 'searchable title')`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.databases.Writer.Exec(`UPDATE books_fts_data SET block = x'00' WHERE id > 10`); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.checkFTS(context.Background()); err == nil {
		t.Fatal("FTS integrity check did not report damaged index bookkeeping")
	}
	var rows int
	if err := fixture.databases.Reader.QueryRow(`SELECT count(*) FROM books_fts`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("FTS check changed stored data: rows=%d err=%v", rows, err)
	}
}

func TestOrphanGraceExactBoundary(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	shardDir := filepath.Join(fixture.dataDir, "files", "aa")
	cutoff := time.Now().Add(-orphanGracePeriod).Truncate(time.Millisecond)
	for index, offset := range []time.Duration{-time.Millisecond, 0, time.Millisecond} {
		hash := "aa" + strings.Repeat(string(rune('a'+index)), 62)
		path := filepath.Join(shardDir, hash+".epub")
		writeOldMaintenanceFile(t, path)
		if err := os.Chtimes(path, cutoff.Add(offset), cutoff.Add(offset)); err != nil {
			t.Fatal(err)
		}
	}
	root, err := os.OpenRoot(shardDir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	remaining, removed := 10, 0
	if err := fixture.service.sweepShard(context.Background(), root, "files", "aa", cutoff, &remaining, &removed); err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("files removed at grace boundary = %d, want only the strictly older file", removed)
	}
}

func TestBackupRefusesSymlinkDirectory(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	outside := t.TempDir()
	link := filepath.Join(fixture.dataDir, "backups")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}
	if err := fixture.service.backup(context.Background()); err == nil {
		t.Fatal("backup unexpectedly followed a symlink directory")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("backup wrote outside data root: entries=%d err=%v", len(entries), err)
	}
}

func TestCheckpointDoesNotWaitForActiveReader(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	tx, err := fixture.databases.Reader.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM server_settings`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.databases.Writer.ExecContext(ctx, `INSERT INTO server_settings (key, value, updated_at)
		VALUES ('checkpoint-test', '{}', 1)`); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.checkpoint(ctx); err != nil {
		t.Fatalf("passive checkpoint failed with an active read snapshot: %v", err)
	}
}

func TestDirectoryScanBoundAndCancellation(t *testing.T) {
	directory := t.TempDir()
	for _, name := range []string{"a", "b"} {
		writeOldMaintenanceFile(t, filepath.Join(directory, name))
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if _, err := readDirectory(context.Background(), root, ".", 1); err == nil {
		t.Fatal("directory scan did not enforce its entry bound")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := readDirectory(ctx, root, ".", 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("directory scan ignored cancellation: %v", err)
	}
}

func TestRepublishedCoverIsNotRemovedByAnEarlierOrphanScan(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	full := []byte("normalized cover")
	thumbnail := []byte("normalized thumbnail")
	digest := sha256.Sum256(full)
	hash := hex.EncodeToString(digest[:])
	if err := fixture.service.blobs.PublishCover(hash, full, thumbnail); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-orphanGracePeriod - time.Hour)
	for _, name := range []string{hash + ".jpg", hash + "-w400.jpg"} {
		path := filepath.Join(fixture.dataDir, "covers", hash[:2], name)
		if err := os.Chtimes(path, old, old); err != nil {
			t.Fatal(err)
		}
	}
	cutoff := time.Now().Add(-orphanGracePeriod)
	if err := fixture.service.blobs.PublishCover(hash, full, thumbnail); err != nil {
		t.Fatal(err)
	}
	shard, err := os.OpenRoot(filepath.Join(fixture.dataDir, "covers", hash[:2]))
	if err != nil {
		t.Fatal(err)
	}
	defer shard.Close()
	for _, name := range []string{hash + ".jpg", hash + "-w400.jpg"} {
		removed, err := fixture.service.removeOrphan(context.Background(), shard, name, hash, "cover", cutoff)
		if err != nil || removed {
			t.Fatalf("republished %s was removed before its catalog commit: removed=%v err=%v", name, removed, err)
		}
	}
}
