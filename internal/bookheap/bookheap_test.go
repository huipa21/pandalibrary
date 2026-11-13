package bookheap

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

var admin = catalog.Viewer{UserID: 1, IsAdmin: true}

type fixture struct {
	service *Service
	db      *db.DB
	blobs   *blobstore.Store
	heap    string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "test.db")
	databases, err := db.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Error(err)
		}
	})
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id, username, display_name, password_hash, role, locale, created_at, updated_at) VALUES (1,'admin','Admin','test','admin','en',1,1)`,
		`INSERT INTO libraries (id,name,slug,created_at,updated_at) VALUES (1,'Main','main',1,1)`,
	} {
		if _, err := databases.Writer.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	blobs, err := blobstore.New(root)
	if err != nil {
		t.Fatal(err)
	}
	heap := filepath.Join(root, "bookheap")
	service, err := New(Options{Writer: databases.Writer, Reader: databases.Reader, Blobs: blobs, Dir: heap,
		MaxBytes: 1 << 20, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := service.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return fixture{service, databases, blobs, heap}
}

func makeArchive(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, name := range []string{"mimetype", "META-INF/container.xml", "OPS/package.opf", "OPS/cover.png", "OPS/extra.txt"} {
		data, ok := files[name]
		if !ok {
			continue
		}
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

// testEPUB returns the extract fixture EPUB with a cover; extra changes its SHA-256.
func testEPUB(t *testing.T, extra string) []byte {
	t.Helper()
	var cover bytes.Buffer
	if err := png.Encode(&cover, image.NewRGBA(image.Rect(0, 0, 4, 8))); err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{"mimetype": []byte("application/epub+zip"), "OPS/cover.png": cover.Bytes(), "OPS/extra.txt": []byte(extra)}
	for _, item := range []struct{ source, target string }{{"container.xml", "META-INF/container.xml"}, {"package.opf", "OPS/package.opf"}} {
		data, err := os.ReadFile(filepath.Join("..", "extract", "testdata", "epub2", item.source))
		if err != nil {
			t.Fatal(err)
		}
		files[item.target] = data
	}
	return makeArchive(t, files)
}

func sum(data []byte) string {
	value := sha256.Sum256(data)
	return hex.EncodeToString(value[:])
}

func (f fixture) write(t *testing.T, rel string, data []byte, age time.Duration) {
	t.Helper()
	path := filepath.Join(f.heap, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o640); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-age)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
}

func (f fixture) scan(t *testing.T) Scan {
	t.Helper()
	if _, _, err := f.service.StartScan(admin); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		scan, err := f.service.LatestScan(admin)
		if err != nil {
			t.Fatal(err)
		}
		if scan.Status != ScanRunning {
			return *scan
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("scan did not finish")
	return Scan{}
}

func (f fixture) visibleFiles(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(f.heap)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func TestUploadStoresMetadataCoverAndUniqueNames(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	item, err := f.service.Upload(ctx, admin, "The Book.epub", bytes.NewReader(testEPUB(t, "a")))
	if err != nil {
		t.Fatal(err)
	}
	if item.Title != "The Fixture Book" || len(item.Authors) == 0 || item.Status != StatusReady || item.Source != "upload" ||
		item.RelPath != "The Book.epub" || item.Format == nil || *item.Format != "epub" || !item.HasCover || item.CoverURL == nil ||
		item.AddedBy == nil || *item.AddedBy != 1 || item.TargetShelfIDs == nil || item.SHA256 == nil || *item.SHA256 != sum(testEPUB(t, "a")) {
		t.Fatalf("item: %+v", item)
	}
	second, err := f.service.Upload(ctx, admin, "The Book.epub", bytes.NewReader(testEPUB(t, "b")))
	if err != nil {
		t.Fatal(err)
	}
	third, err := f.service.Upload(ctx, admin, "CON.epub", bytes.NewReader(testEPUB(t, "c")))
	if err != nil {
		t.Fatal(err)
	}
	if second.RelPath != "The Book (2).epub" || third.RelPath != "CON_.epub" {
		t.Fatalf("names: %q %q", second.RelPath, third.RelPath)
	}
	for _, thumbnail := range []bool{false, true} {
		content, err := f.service.OpenCover(ctx, admin, item.ID, thumbnail)
		if err != nil {
			t.Fatal(err)
		}
		if content.ContentType != "image/jpeg" || (thumbnail != strings.HasSuffix(content.ETag, "-w400")) {
			t.Fatalf("cover: %+v", content)
		}
		if err := content.File.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if names := f.visibleFiles(t); len(names) != 3 {
		t.Fatalf("heap files: %v", names)
	}
	got, err := f.service.Get(ctx, admin, item.ID)
	if err != nil || got.ID != item.ID {
		t.Fatalf("get: %+v %v", got, err)
	}
	if _, err := f.service.Get(ctx, admin, 999); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, err := f.service.Get(ctx, catalog.Viewer{UserID: 2}, item.ID); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatalf("non-admin: %v", err)
	}
}

func TestUploadRejections(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	data := testEPUB(t, "a")
	if _, err := f.service.Upload(ctx, admin, "first.epub", bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	var duplicate *DuplicateError
	if _, err := f.service.Upload(ctx, admin, "again.epub", bytes.NewReader(data)); !errors.As(err, &duplicate) || duplicate.ItemID == 0 {
		t.Fatalf("item duplicate: %v", err)
	}
	library := testEPUB(t, "library")
	for _, statement := range []string{
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (7, 1, 'B', 'b', 1, 1)`,
		`INSERT INTO book_files (book_id, sha256, format, size_bytes, original_filename, created_at) VALUES (7, '` + sum(library) + `', 'epub', 10, 'b.epub', 1)`,
	} {
		if _, err := f.db.Writer.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if item, err := f.service.Upload(ctx, admin, "lib.epub", bytes.NewReader(library)); err != nil || item.Status != StatusReady || item.DuplicateOfBookID != nil {
		t.Fatalf("library file should wait for a target library: %+v, %v", item, err)
	}
	if _, err := f.service.Upload(ctx, admin, "big.epub", bytes.NewReader(make([]byte, 1<<20+1))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("too large: %v", err)
	}
	if _, err := f.service.Upload(ctx, admin, "bad.epub", strings.NewReader("not a book")); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("unsupported: %v", err)
	}
	if _, err := f.service.Upload(ctx, admin, "empty.epub", strings.NewReader("")); !errors.Is(err, catalog.ErrInvalid) {
		t.Fatalf("empty: %v", err)
	}
	for _, name := range []string{"", "../x.epub", "a/b.epub"} {
		if _, err := f.service.Upload(ctx, admin, name, bytes.NewReader(testEPUB(t, "n"))); !errors.Is(err, catalog.ErrInvalid) {
			t.Fatalf("name %q: %v", name, err)
		}
	}
	if _, err := f.service.Upload(ctx, catalog.Viewer{UserID: 2}, "x.epub", bytes.NewReader(data)); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatalf("non-admin: %v", err)
	}
	if names := f.visibleFiles(t); len(names) != 2 || names[0] != "first.epub" || names[1] != "lib.epub" {
		t.Fatalf("heap files: %v", names)
	}
}

func TestConcurrentIdenticalUploads(t *testing.T) {
	f := newFixture(t)
	data := testEPUB(t, "same")
	var wait sync.WaitGroup
	var mu sync.Mutex
	stored, duplicates := 0, 0
	for range 6 {
		wait.Go(func() {
			_, err := f.service.Upload(context.Background(), admin, "same.epub", bytes.NewReader(data))
			var duplicate *DuplicateError
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				stored++
			case errors.As(err, &duplicate):
				duplicates++
			default:
				t.Error(err)
			}
		})
	}
	wait.Wait()
	if stored != 1 || duplicates != 5 {
		t.Fatalf("stored %d duplicates %d", stored, duplicates)
	}
	if names := f.visibleFiles(t); len(names) != 1 {
		t.Fatalf("heap files: %v", names)
	}
}

func TestScanIndexesHeapAndRemovesMissingFiles(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	old := time.Hour
	f.write(t, "top.epub", testEPUB(t, "top"), old)
	f.write(t, "nested/deeper/inner.epub", testEPUB(t, "inner"), old)
	f.write(t, "copy.epub", testEPUB(t, "top"), old)
	f.write(t, "broken.epub", []byte("garbage"), old)
	f.write(t, "notes.txt", []byte("hello"), old)
	f.write(t, ".hidden.epub", testEPUB(t, "hidden"), old)
	f.write(t, "fresh.epub", testEPUB(t, "fresh"), 0)
	symlinkErr := os.Symlink(filepath.Join(f.heap, "top.epub"), filepath.Join(f.heap, "link.epub"))
	if symlinkErr != nil {
		t.Logf("symlink scan case unavailable: %v", symlinkErr)
	}

	scan := f.scan(t)
	skipped := int64(1)
	if symlinkErr == nil {
		skipped = 2
	}
	if scan.Status != ScanCompleted || scan.Added != 4 || scan.Invalid != 1 || scan.Duplicates != 1 || scan.InProgress != 1 ||
		scan.Skipped != skipped || scan.Updated != 0 || scan.Removed != 0 || scan.FinishedAt == nil {
		t.Fatalf("first scan: %+v", scan)
	}
	page, err := f.service.List(ctx, admin, ListOptions{})
	if err != nil || page.Total != 4 {
		t.Fatalf("list: %+v %v", page, err)
	}
	statuses := map[string]Item{}
	for _, item := range page.Items {
		statuses[item.RelPath] = item
	}
	if statuses["broken.epub"].Status != StatusInvalid || statuses["broken.epub"].Error == nil ||
		statuses["nested/deeper/inner.epub"].Status != StatusReady || statuses["nested/deeper/inner.epub"].Source != "scan" {
		t.Fatalf("items: %+v", statuses)
	}
	if statuses["top.epub"].Status != StatusReady || statuses["copy.epub"].Status != StatusDuplicate ||
		statuses["copy.epub"].DuplicateOfItemID == nil || *statuses["copy.epub"].DuplicateOfItemID != statuses["top.epub"].ID {
		// Directory order decides which copy is the original; exactly one must point at the other.
		if statuses["top.epub"].Status != StatusDuplicate || statuses["copy.epub"].Status != StatusReady {
			t.Fatalf("duplicates: %+v %+v", statuses["top.epub"], statuses["copy.epub"])
		}
	}

	if second := f.scan(t); second.Unchanged != 4 || second.Added != 0 || second.InProgress != 1 || second.ID != scan.ID+1 {
		t.Fatalf("second scan: %+v", second)
	}
	f.service.now = func() time.Time { return time.Now().Add(time.Minute) }
	if third := f.scan(t); third.Added != 1 || third.Unchanged != 4 {
		t.Fatalf("settled scan: %+v", third)
	}
	if err := os.Remove(filepath.Join(f.heap, "broken.epub")); err != nil {
		t.Fatal(err)
	}
	f.write(t, "nested/deeper/inner.epub", testEPUB(t, "changed"), old/2)
	if fourth := f.scan(t); fourth.Removed != 1 || fourth.Updated != 1 || fourth.Unchanged != 3 {
		t.Fatalf("fourth scan: %+v", fourth)
	}
	page, err = f.service.List(ctx, admin, ListOptions{Status: StatusInvalid})
	if err != nil || page.Total != 0 {
		t.Fatalf("invalid after removal: %+v %v", page, err)
	}
}

func TestScanLifecycle(t *testing.T) {
	f := newFixture(t)
	if scan, err := f.service.LatestScan(admin); err != nil || scan != nil {
		t.Fatalf("initial: %+v %v", scan, err)
	}
	for index := range 50 {
		f.write(t, "dir/file"+string(rune('a'+index%26))+string(rune('a'+index/26))+".epub", testEPUB(t, string(rune(index))), time.Hour)
	}
	// Keep the first scan from finishing before the second start request.
	f.service.commitMu.Lock()
	first, started, err := f.service.StartScan(admin)
	if err != nil || !started {
		f.service.commitMu.Unlock()
		t.Fatalf("start: %v %v", started, err)
	}
	again, started, err := f.service.StartScan(admin)
	f.service.commitMu.Unlock()
	if err != nil || started || again.ID != first.ID {
		t.Fatalf("restart: %+v %v %v", again, started, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := f.service.Close(ctx); err != nil {
		t.Fatal(err)
	}
	latest, err := f.service.LatestScan(admin)
	if err != nil || latest.Status == ScanRunning {
		t.Fatalf("after close: %+v %v", latest, err)
	}
	if _, _, err := f.service.StartScan(admin); !errors.Is(err, ErrStopped) {
		t.Fatalf("start after close: %v", err)
	}
	if _, err := f.service.Upload(context.Background(), admin, "x.epub", bytes.NewReader(testEPUB(t, "x"))); !errors.Is(err, ErrStopped) {
		t.Fatalf("upload after close: %v", err)
	}
}

func TestListFiltersAndCursor(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	for index := range 5 {
		if _, err := f.service.Upload(ctx, admin, "Book "+string(rune('A'+index))+".epub", bytes.NewReader(testEPUB(t, string(rune('a'+index))))); err != nil {
			t.Fatal(err)
		}
	}
	var seen []int64
	cursor := ""
	for {
		page, err := f.service.List(ctx, admin, ListOptions{Limit: 2, Cursor: cursor})
		if err != nil || page.Total != 5 {
			t.Fatalf("page: %+v %v", page, err)
		}
		for _, item := range page.Items {
			seen = append(seen, item.ID)
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if len(seen) != 5 || seen[0] != 5 || seen[4] != 1 {
		t.Fatalf("order: %v", seen)
	}
	if page, err := f.service.List(ctx, admin, ListOptions{Query: "book c"}); err != nil || page.Total != 1 || page.Items[0].FileName != "Book C.epub" {
		t.Fatalf("query: %+v %v", page, err)
	}
	if page, err := f.service.List(ctx, admin, ListOptions{Query: "fixture"}); err != nil || page.Total != 5 {
		t.Fatalf("title query: %+v %v", page, err)
	}
	first, err := f.service.List(ctx, admin, ListOptions{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, options := range []ListOptions{
		{Status: "bogus"}, {Limit: 101}, {Limit: -1}, {Cursor: "!!"}, {Query: strings.Repeat("x", 201)},
		{Cursor: *first.NextCursor, Status: StatusReady},
	} {
		if _, err := f.service.List(ctx, admin, options); !errors.Is(err, catalog.ErrInvalid) {
			t.Fatalf("options %+v: %v", options, err)
		}
	}
}

func TestDelete(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	kept, err := f.service.Upload(ctx, admin, "kept.epub", bytes.NewReader(testEPUB(t, "kept")))
	if err != nil {
		t.Fatal(err)
	}
	gone, err := f.service.Upload(ctx, admin, "gone.epub", bytes.NewReader(testEPUB(t, "gone")))
	if err != nil {
		t.Fatal(err)
	}
	busy, err := f.service.Upload(ctx, admin, "busy.epub", bytes.NewReader(testEPUB(t, "busy")))
	if err != nil {
		t.Fatal(err)
	}
	changed, err := f.service.Upload(ctx, admin, "changed.epub", bytes.NewReader(testEPUB(t, "changed")))
	if err != nil {
		t.Fatal(err)
	}
	missing, err := f.service.Upload(ctx, admin, "missing.epub", bytes.NewReader(testEPUB(t, "missing")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Writer.Exec(`UPDATE bookheap_items SET status = 'queued' WHERE id = ?`, busy.ID); err != nil {
		t.Fatal(err)
	}
	f.write(t, "changed.epub", []byte("edited by hand"), 0)
	if err := os.Remove(filepath.Join(f.heap, "missing.epub")); err != nil {
		t.Fatal(err)
	}
	results, err := f.service.Delete(ctx, admin, []int64{gone.ID, busy.ID, changed.ID, missing.ID, 999})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"", DeleteBusy, DeleteChanged, "", DeleteNotFound}
	for index, result := range results {
		code := ""
		if result.Error != nil {
			code = *result.Error
		}
		if code != want[index] || result.OK != (code == "") {
			t.Fatalf("result %d: %+v", index, result)
		}
	}
	names := f.visibleFiles(t)
	if strings.Join(names, ",") != "busy.epub,changed.epub,kept.epub" {
		t.Fatalf("heap files: %v", names)
	}
	page, err := f.service.List(ctx, admin, ListOptions{})
	if err != nil || page.Total != 3 {
		t.Fatalf("rows: %+v %v", page, err)
	}
	_ = kept
	for _, ids := range [][]int64{nil, {0}, {1, 1}, make([]int64, MaxDeleteIDs+1)} {
		if _, err := f.service.Delete(ctx, admin, ids); !errors.Is(err, catalog.ErrInvalid) {
			t.Fatalf("ids %v: %v", ids, err)
		}
	}
}

func TestSanitizeStem(t *testing.T) {
	for input, want := range map[string]string{
		"a.epub": "a", "...hidden.epub": "hidden", "  .epub": "book", "a:b?.epub": "a_b_", "nul.pdf": "nul_",
		"tab\there.epub": "tab_here",
	} {
		if got := sanitizeStem(input); got != want {
			t.Errorf("sanitizeStem(%q) = %q, want %q", input, got, want)
		}
	}
}
