package importer

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/db/sqlc"
)

func eventually(t *testing.T, check func() bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for !check() {
		select {
		case <-ctx.Done():
			t.Fatal("condition did not become true")
		case <-ticker.C:
		}
	}
}

func putDrop(t *testing.T, f fixture, name string, data []byte) {
	t.Helper()
	path := filepath.Join(f.service.options.DropDir, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestWatcherStartupScanAndOutcomes(t *testing.T) {
	f := newFixture(t)
	data := testEPUB(t)
	putDrop(t, f, "book.epub", data)
	putDrop(t, f, filepath.Join("other", "duplicate.epub"), data)
	putDrop(t, f, "corrupt.epub", []byte("invalid epub"))
	for _, name := range []string{".hidden.epub", "pending.part", "pending.crdownload", "pending.tmp", filepath.Join("unknown", "ignored.epub")} {
		putDrop(t, f, name, data)
	}
	if err := f.service.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool {
		rows, err := sqlc.New(f.db.Reader).ImportHistory(context.Background(), sqlc.ImportHistoryParams{PageLimit: 10})
		if err != nil || len(rows) != 3 {
			return false
		}
		for _, row := range rows {
			if row.Status == "pending" || row.Status == "processing" {
				return false
			}
		}
		_, err = os.Stat(filepath.Join(f.service.options.DropDir, "corrupt.epub"))
		return os.IsNotExist(err)
	})
	rows, err := sqlc.New(f.db.Reader).ImportHistory(context.Background(), sqlc.ImportHistoryParams{PageLimit: 10})
	if err != nil {
		t.Fatal(err)
	}
	outcomes := map[string]int{}
	for _, row := range rows {
		outcomes[row.Status]++
		if row.OriginalName == "duplicate.epub" && row.LibraryID != 2 {
			t.Fatalf("wrong subfolder library: %+v", row)
		}
	}
	if outcomes["imported"] != 1 || outcomes["duplicate"] != 1 || outcomes["failed"] != 1 {
		t.Fatal(outcomes)
	}
	for _, folder := range []string{".duplicates", ".failed"} {
		entries, err := os.ReadDir(filepath.Join(f.service.options.DropDir, folder))
		if err != nil {
			t.Fatal(err)
		}
		want := 1
		if folder == ".failed" {
			want = 2
		}
		if len(entries) != want {
			t.Fatalf("%s entries: %v", folder, entries)
		}
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".error.txt") {
				body, err := os.ReadFile(filepath.Join(f.service.options.DropDir, folder, entry.Name()))
				if err != nil || len(body) > 2049 || strings.Contains(string(body), f.root) {
					t.Fatalf("unsafe failure sidecar %q %v", body, err)
				}
			}
		}
	}
	for _, name := range []string{".hidden.epub", "pending.part", "pending.crdownload", "pending.tmp", filepath.Join("unknown", "ignored.epub")} {
		if _, err := os.Stat(filepath.Join(f.service.options.DropDir, name)); err != nil {
			t.Errorf("ignored file %s: %v", name, err)
		}
	}
	putDrop(t, f, "live.epub", testEPUB(t))
	eventually(t, func() bool {
		_, err := os.Stat(filepath.Join(f.service.options.DropDir, "live.epub"))
		return os.IsNotExist(err)
	})
}

func TestScanDebounceIgnoredPathsAndSymlinks(t *testing.T) {
	f := newFixture(t)
	putDrop(t, f, "book.epub", []byte("first"))
	putDrop(t, f, filepath.Join("other", "other.epub"), []byte("second"))
	putDrop(t, f, "ignore.PART", []byte("ignored"))
	candidates := make(map[string]candidate)
	now := time.Now()
	if err := f.service.scanDrop(context.Background(), nil, map[string]bool{}, candidates, now); err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 || candidates["book.epub"].libraryID != 1 || candidates[filepath.Join("other", "other.epub")].libraryID != 2 {
		t.Fatalf("candidates: %+v", candidates)
	}
	if err := f.service.scanDrop(context.Background(), nil, map[string]bool{}, candidates, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if !candidates["book.epub"].stableSince.Equal(now) {
		t.Fatal("unchanged scan reset debounce")
	}
	putDrop(t, f, "book.epub", []byte("changed size"))
	if err := f.service.scanDrop(context.Background(), nil, map[string]bool{}, candidates, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if !candidates["book.epub"].stableSince.Equal(now.Add(2 * time.Second)) {
		t.Fatal("change did not reset debounce")
	}
	for _, name := range []string{"../outside", filepath.Join("other", "nested", "file.epub"), f.root} {
		if _, err := f.service.dropInfo(name); err == nil {
			t.Errorf("accepted unsafe path %s", name)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside.epub")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(f.service.options.DropDir, "link.epub")
	if err := os.Symlink(outside, link); err != nil {
		t.Log("symlink creation unavailable:", err)
		return
	}
	if _, err := f.service.dropInfo("link.epub"); err == nil {
		t.Fatal("followed symlink")
	}
}

func TestDropCleanupRecoveryAndBoundedErrors(t *testing.T) {
	f := newFixture(t)
	putDrop(t, f, "bad.epub", []byte("bad"))
	info, err := f.service.dropInfo("bad.epub")
	if err != nil {
		t.Fatal(err)
	}
	input := manifest{DropPath: "bad.epub", DropSize: info.Size(), DropMtime: info.ModTime().UnixNano(), Failure: "failed"}
	job, err := f.service.enqueue(context.Background(), "drop_folder", 1, 0, "bad.epub", input)
	if err != nil {
		t.Fatal(err)
	}
	message := f.service.safeError(errorsForTest(f.root + "\n" + strings.Repeat("x", 4096)))
	if err := f.service.finish(context.Background(), sqlc.New(f.db.Writer), job.ID, "failed", 0, 0, message); err != nil {
		t.Fatal(err)
	}
	if err := f.service.recoverManifests(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.service.options.DropDir, "bad.epub")); !os.IsNotExist(err) {
		t.Fatalf("source not recovered: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(f.service.options.DropDir, ".failed"))
	if err != nil || len(entries) != 2 {
		t.Fatalf("archive: %v %v", entries, err)
	}
}

type errorsForTest string

func (message errorsForTest) Error() string { return string(message) }

func TestCleanupPreservesAndReleasesChangedDropSource(t *testing.T) {
	f := newFixture(t)
	putDrop(t, f, "changed.epub", []byte("original"))
	info, err := f.service.dropInfo("changed.epub")
	if err != nil {
		t.Fatal(err)
	}
	input := manifest{DropPath: "changed.epub", DropSize: info.Size(), DropMtime: info.ModTime().UnixNano()}
	job, err := f.service.enqueue(context.Background(), "drop_folder", 1, 0, "changed.epub", input)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.service.finish(context.Background(), sqlc.New(f.db.Writer), job.ID, "imported", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	putDrop(t, f, "changed.epub", []byte("replacement content"))
	row, err := sqlc.New(f.db.Reader).ImportJob(context.Background(), job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.service.cleanup(row, input); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(f.service.options.DropDir, "changed.epub"))
	if err != nil || string(data) != "replacement content" || f.service.dropQueued["changed.epub"] {
		t.Fatalf("replacement %q blocked=%v %v", data, f.service.dropQueued["changed.epub"], err)
	}
}

func TestPollingFallbackWithoutFSNotify(t *testing.T) {
	f := newFixture(t)
	f.service.options.DropPoll = 50 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); f.service.watch(ctx, nil) }()
	defer func() { cancel(); <-done }()
	putDrop(t, f, "poll.epub", testEPUB(t))
	eventually(t, func() bool {
		var count int
		err := f.db.Reader.QueryRow(`SELECT count(*) FROM import_jobs WHERE original_name='poll.epub' AND status='pending'`).Scan(&count)
		return err == nil && count == 1
	})
}
