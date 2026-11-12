package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pandalibrary/internal/config"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

func testDirectory(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp(".", ".backup-test-")
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
	return dir
}

func fixture(t *testing.T) (*Service, *db.DB) {
	t.Helper()
	parent := testDirectory(t)
	cfg := config.Config{
		DataDir: filepath.Join(parent, "data #100% '书籍'"), DropDir: filepath.Join(parent, "external-drop"),
		BookheapDir: filepath.Join(parent, "external-heap"),
	}
	service, err := New(cfg, nil, &sync.RWMutex{})
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range service.Dirs {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	databases, err := db.Open(context.Background(), filepath.Join(cfg.DataDir, "pandalibrary.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Error(err)
		}
	})
	runner, err := migrations.NewRunner(databases.Writer, filepath.Join(cfg.DataDir, "pandalibrary.db"), migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	service.Writer = databases.Writer
	return service, databases
}

func write(t *testing.T, name, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestFullBackupRoundTripAndOfflineReplacement(t *testing.T) {
	s, databases := fixture(t)
	ctx := context.Background()
	if _, err := databases.Writer.Exec(`INSERT INTO users (username,password_hash,role,locale,created_at,updated_at) VALUES ('original','hash','admin','en',1,1)`); err != nil {
		t.Fatal(err)
	}
	for _, root := range roots {
		write(t, filepath.Join(s.Dirs[root], "nested", "content"), "original-"+root)
	}
	originalTime := time.Unix(1700000000, 123456700)
	for _, root := range []string{"drop", "bookheap", "tmp"} {
		name := filepath.Join(s.Dirs[root], "nested", "content")
		if err := os.Chtimes(name, originalTime, originalTime); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(s.directory(), "keep.txt"), "preserve backups")
	write(t, filepath.Join(s.directory(), ".create-stale", "pandalibrary.db"), "abandoned backup snapshot")
	info, err := s.Create(ctx)
	if err != nil {
		t.Fatal(err)
	}
	archiveFile, err := s.Open(info.Name)
	if err != nil {
		t.Fatal(err)
	}
	gz, err := gzip.NewReader(archiveFile)
	if err != nil {
		archiveFile.Close()
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	seen := map[string]bool{}
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		seen[header.Name] = true
		if strings.Contains(header.Name, ".create-") || strings.HasPrefix(header.Name, "backups") ||
			strings.Contains(header.Name, "pandalibrary.db-") {
			t.Fatalf("archive includes backup work or SQLite sidecars: %s", header.Name)
		}
	}
	if err := errors.Join(gz.Close(), archiveFile.Close()); err != nil {
		t.Fatal(err)
	}
	if !seen["tmp/nested/content"] {
		t.Fatal("live import staging was excluded along with backup work")
	}
	if _, err := databases.Writer.Exec(`UPDATE users SET username='changed'`); err != nil {
		t.Fatal(err)
	}
	for _, root := range roots {
		write(t, filepath.Join(s.Dirs[root], "nested", "content"), "changed")
		write(t, filepath.Join(s.Dirs[root], "extra"), "must disappear")
	}
	saved, err := s.Open(info.Name)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Stage(ctx, saved); err != nil {
		t.Fatal(err)
	}
	if err := saved.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Stage(ctx, bytes.NewReader(nil)); !errors.Is(err, ErrPending) {
		t.Fatalf("second restore = %v", err)
	}
	content, err := os.ReadFile(filepath.Join(s.Dirs["files"], "nested", "content"))
	if err != nil || string(content) != "changed" {
		t.Fatalf("staging changed live files: %q, %v", content, err)
	}
	if err := databases.Close(); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		write(t, filepath.Join(s.DataDir, "pandalibrary.db"+suffix), "stale sidecar")
	}
	if err := s.ApplyPending(ctx); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Stat(filepath.Join(s.DataDir, "pandalibrary.db"+suffix)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("stale SQLite sidecar survived restore: %s, %v", suffix, err)
		}
	}
	if s.Pending() {
		t.Fatal("restore is still pending")
	}
	for _, root := range roots {
		content, err := os.ReadFile(filepath.Join(s.Dirs[root], "nested", "content"))
		if err != nil || string(content) != "original-"+root {
			t.Fatalf("%s not restored: %q, %v", root, content, err)
		}
		if _, err := os.Stat(filepath.Join(s.Dirs[root], "extra")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("extra file survived in %s: %v", root, err)
		}
	}
	for _, root := range []string{"drop", "bookheap", "tmp"} {
		info, err := os.Stat(filepath.Join(s.Dirs[root], "nested", "content"))
		if err != nil || !info.ModTime().Equal(originalTime) {
			t.Fatalf("%s file mtime was not preserved: %v, %v", root, info, err)
		}
	}
	restored, err := db.Open(ctx, filepath.Join(s.DataDir, "pandalibrary.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var username string
	if err := restored.Reader.QueryRow("SELECT username FROM users").Scan(&username); err != nil || username != "original" {
		t.Fatalf("database not restored: %s, %v", username, err)
	}
	for _, name := range []string{"keep.txt", info.Name} {
		if _, err := os.Stat(filepath.Join(s.directory(), name)); err != nil {
			t.Fatal(err)
		}
	}
	list, err := s.List()
	if err != nil || len(list) != 1 || list[0].Name != info.Name {
		t.Fatalf("saved archive list = %+v, %v", list, err)
	}
}

func archive(t *testing.T, headers []*tar.Header, contents [][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	tw := tar.NewWriter(gz)
	for i, h := range headers {
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if i < len(contents) && contents[i] != nil {
			if _, err := tw.Write(contents[i]); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := errors.Join(tw.Close(), gz.Close()); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestRejectInvalidArchivesWithoutModifyingData(t *testing.T) {
	s, _ := fixture(t)
	write(t, filepath.Join(s.Dirs["files"], "sentinel"), "unchanged")
	badDB := []byte("not SQLite")
	sum := sha256.Sum256(badDB)
	m, err := json.Marshal(manifest{Version: 1, Files: map[string]record{
		"pandalibrary.db": {int64(len(badDB)), hex.EncodeToString(sum[:])},
	}})
	if err != nil {
		t.Fatal(err)
	}
	for name, h := range map[string]*tar.Header{
		"traversal": {Name: "../escaped", Typeflag: tar.TypeReg},
		"absolute":  {Name: "/escaped", Typeflag: tar.TypeReg},
		"windows":   {Name: `files\..\escaped`, Typeflag: tar.TypeReg},
		"drive":     {Name: "C:/escaped", Typeflag: tar.TypeReg},
		"symlink":   {Name: "files/link", Typeflag: tar.TypeSymlink, Linkname: "../outside"},
		"hardlink":  {Name: "files/link", Typeflag: tar.TypeLink, Linkname: "pandalibrary.db"},
		"device":    {Name: "files/device", Typeflag: tar.TypeChar},
		"reserved":  {Name: "files/CON.txt", Typeflag: tar.TypeReg},
		"backups":   {Name: "backups/overwrite", Typeflag: tar.TypeReg},
		"depth":     {Name: "files/" + strings.Repeat("a/", 33) + "file", Typeflag: tar.TypeReg},
	} {
		t.Run(name, func(t *testing.T) {
			data := archive(t, []*tar.Header{h}, nil)
			if err := s.Stage(context.Background(), bytes.NewReader(data)); !errors.Is(err, ErrInvalid) {
				t.Fatalf("accepted archive: %v", err)
			}
		})
	}
	headers := []*tar.Header{{Name: "pandalibrary.db", Typeflag: tar.TypeReg, Size: int64(len(badDB))}}
	contents := [][]byte{badDB}
	for _, root := range roots {
		headers = append(headers, &tar.Header{Name: root, Typeflag: tar.TypeDir})
		contents = append(contents, nil)
	}
	headers = append(headers, &tar.Header{Name: "manifest.json", Typeflag: tar.TypeReg, Size: int64(len(m))})
	contents = append(contents, m)
	cases := map[string][]byte{
		"invalid database": archive(t, headers, contents),
		"duplicate": archive(t, []*tar.Header{
			{Name: "files/a", Typeflag: tar.TypeReg}, {Name: "files/a", Typeflag: tar.TypeReg},
		}, nil),
		"case duplicate": archive(t, []*tar.Header{
			{Name: "files/A", Typeflag: tar.TypeReg}, {Name: "files/a", Typeflag: tar.TypeReg},
		}, nil),
		"missing manifest": archive(t, []*tar.Header{{Name: "files", Typeflag: tar.TypeDir}}, nil),
	}
	info, err := s.Create(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	valid, err := os.ReadFile(filepath.Join(s.directory(), info.Name))
	if err != nil {
		t.Fatal(err)
	}
	cases["truncated gzip"] = valid[:len(valid)-6]
	cases["trailing junk"] = append(append([]byte{}, valid...), []byte("junk")...)
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if err := s.Stage(context.Background(), bytes.NewReader(data)); !errors.Is(err, ErrInvalid) {
				t.Fatalf("accepted archive: %v", err)
			}
		})
	}
	if s.Pending() {
		t.Fatal("invalid restore was staged")
	}
	content, err := os.ReadFile(filepath.Join(s.Dirs["files"], "sentinel"))
	if err != nil || string(content) != "unchanged" {
		t.Fatalf("live data changed: %q, %v", content, err)
	}
}

func TestInterruptedRestoreRollsBackBeforeOpeningData(t *testing.T) {
	s, databases := fixture(t)
	if err := databases.Close(); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(s.Dirs["files"], "example")
	write(t, target, "new")
	old := target + ".old"
	write(t, old, "original")
	if err := s.prepare(); err != nil {
		t.Fatal(err)
	}
	j := journal{Entries: []replacement{{Target: target, New: target + ".new", Old: old, HadOld: true}}}
	if err := s.saveJournal(j); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "original" {
		t.Fatalf("rollback = %q, %v", content, err)
	}
}

func TestPlainTarCaseAliasesAreRejectedBeforeDatabaseValidation(t *testing.T) {
	s, _ := fixture(t)
	data := archive(t, []*tar.Header{
		{Name: "files/Sub/a", Typeflag: tar.TypeReg},
		{Name: "files/sub/b", Typeflag: tar.TypeReg},
	}, nil)
	err := s.Stage(context.Background(), bytes.NewReader(data))
	if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "case-colliding paths") {
		t.Fatalf("case alias was not rejected by path validation: %v", err)
	}
}

func TestInterruptedRestoreRecoversDatabaseAndSidecarsTogether(t *testing.T) {
	s, databases := fixture(t)
	if err := databases.Close(); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(s.DataDir, "pandalibrary.db")
	original, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	walPath := dbPath + "-wal"
	shmPath := dbPath + "-shm"
	write(t, walPath, "original WAL")
	write(t, shmPath, "new SHM without original")
	write(t, filepath.Join(s.Dirs["files"], "original"), "original media")
	j := journal{Entries: []replacement{
		{Target: dbPath, New: dbPath + ".new", Old: dbPath + ".old", HadOld: true},
		{Target: walPath, New: walPath + ".new", Old: walPath + ".old", HadOld: true},
		{Target: shmPath, New: shmPath + ".new", Old: shmPath + ".old", HadOld: false},
		{Target: s.Dirs["files"], New: s.Dirs["files"] + ".new", Old: s.Dirs["files"] + ".old", HadOld: true},
	}}
	for _, entry := range j.Entries {
		if entry.HadOld {
			if err := os.Rename(entry.Target, entry.Old); err != nil {
				t.Fatal(err)
			}
		}
	}
	write(t, dbPath, "partially installed database")
	write(t, filepath.Join(s.Dirs["files"], "new"), "partially installed media")
	if err := s.prepare(); err != nil {
		t.Fatal(err)
	}
	if err := s.saveJournal(j); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(dbPath)
	if err != nil || !bytes.Equal(content, original) {
		t.Fatalf("original database not recovered: %v", err)
	}
	content, err = os.ReadFile(walPath)
	if err != nil || string(content) != "original WAL" {
		t.Fatalf("original WAL not recovered: %q, %v", content, err)
	}
	if _, err := os.Stat(shmPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("new SHM survived rollback: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.Dirs["files"], "original")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(s.Dirs["files"], "new")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("new media survived rollback: %v", err)
	}
	if err := s.ApplyPending(context.Background()); err != nil {
		t.Fatalf("recovery was not restart-safe: %v", err)
	}
}

func TestCommittedRestoreRecoveryKeepsNewDataAndFinishesCleanup(t *testing.T) {
	s, databases := fixture(t)
	if err := databases.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.prepare(); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(s.Dirs["files"], "example")
	write(t, target, "restored")
	write(t, target+".old", "original")
	write(t, filepath.Join(s.directory(), pendingName), "already applied archive")
	write(t, filepath.Join(s.directory(), "keep.txt"), "preserve")
	j := journal{Committed: true, Entries: []replacement{
		{Target: target, New: target + ".new", Old: target + ".old", HadOld: true},
	}}
	if err := s.saveJournal(j); err != nil {
		t.Fatal(err)
	}
	if err := s.ApplyPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "restored" {
		t.Fatalf("committed data rolled back: %q, %v", content, err)
	}
	for _, name := range []string{target + ".old", filepath.Join(s.directory(), pendingName), filepath.Join(s.directory(), journalName)} {
		if _, err := os.Stat(name); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("committed cleanup incomplete: %s, %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(s.directory(), "keep.txt")); err != nil {
		t.Fatal(err)
	}
}

func TestProcessLockAndUnsafeStorage(t *testing.T) {
	dir := testDirectory(t)
	lock, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := Acquire(dir); err == nil {
		second.Close()
		t.Fatal("second process lock succeeded")
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	lock, err = Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	lock.Close()
	if _, err := New(config.Config{DataDir: dir, DropDir: filepath.Join(dir, "files")}, nil, nil); err == nil {
		t.Fatal("overlapping storage accepted")
	}
}
