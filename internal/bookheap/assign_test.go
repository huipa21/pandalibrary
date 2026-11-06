package bookheap

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
	"pandalibrary/internal/importer"
)

type assignFixture struct {
	fixture
	root     string
	catalog  *catalog.Service
	importer *importer.Service
}

func openAssignDB(t *testing.T) (*db.DB, *blobstore.Store, string) {
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
		`INSERT INTO users (id, username, display_name, password_hash, role, locale, created_at, updated_at) VALUES
			(1,'admin','Admin','test','admin','en',1,1), (2,'reader','Reader','test','user','en',1,1)`,
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
	return databases, blobs, root
}

// newAssignServices builds an importer and a bookheap service on shared storage. The
// importer is not started, so tests can inspect queued state or simulate a restart.
func newAssignServices(t *testing.T, databases *db.DB, blobs *blobstore.Store, root string) assignFixture {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	catalogService, err := catalog.NewService(databases.Writer, databases.Reader, blobs)
	if err != nil {
		t.Fatal(err)
	}
	importService, err := importer.New(importer.Options{Writer: databases.Writer, Reader: databases.Reader, Blobs: blobs,
		Catalog: catalogService, DataDir: root, DropDir: filepath.Join(root, "drop"), MaxBytes: 1 << 20, Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	heap := filepath.Join(root, "bookheap")
	service, err := New(Options{Writer: databases.Writer, Reader: databases.Reader, Blobs: blobs, Dir: heap,
		MaxBytes: 1 << 20, Logger: logger, Importer: importService, Catalog: catalogService})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := importService.Stop(ctx); err != nil {
			t.Error(err)
		}
		if err := service.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return assignFixture{fixture: fixture{service, databases, blobs, heap}, root: root, catalog: catalogService, importer: importService}
}

func newAssignFixture(t *testing.T) assignFixture {
	t.Helper()
	databases, blobs, root := openAssignDB(t)
	return newAssignServices(t, databases, blobs, root)
}

func (f assignFixture) start(t *testing.T) {
	t.Helper()
	if err := f.importer.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func (f assignFixture) shelf(t *testing.T, viewer catalog.Viewer, input catalog.ShelfInput) int64 {
	t.Helper()
	shelf, err := f.catalog.CreateShelf(context.Background(), viewer, input)
	if err != nil {
		t.Fatal(err)
	}
	return shelf.ID
}

// items writes and scans one EPUB per name and returns their item IDs in order.
func (f assignFixture) items(t *testing.T, names ...string) []int64 {
	t.Helper()
	for _, name := range names {
		f.write(t, name, testEPUB(t, name), time.Hour)
	}
	f.scan(t)
	ids := make([]int64, 0, len(names))
	for _, name := range names {
		var id int64
		if err := f.db.Reader.QueryRow(`SELECT id FROM bookheap_items WHERE rel_path = ?`, name).Scan(&id); err != nil {
			t.Fatalf("item %s: %v", name, err)
		}
		ids = append(ids, id)
	}
	return ids
}

func (f assignFixture) count(t *testing.T, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := f.db.Reader.QueryRow(query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func (f assignFixture) item(t *testing.T, id int64) (Item, bool) {
	t.Helper()
	item, err := f.service.Get(context.Background(), admin, id)
	if errors.Is(err, catalog.ErrNotFound) {
		return Item{}, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return item, true
}

// eventually polls condition until it holds.
func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (f assignFixture) waitStatus(t *testing.T, id int64, status string) Item {
	t.Helper()
	var item Item
	eventually(t, "item "+strconv.FormatInt(id, 10)+" to become "+status, func() bool {
		var ok bool
		item, ok = f.item(t, id)
		return ok && item.Status == status
	})
	return item
}

func (f assignFixture) waitGone(t *testing.T, id int64, rel string) {
	t.Helper()
	eventually(t, "item "+strconv.FormatInt(id, 10)+" to be imported", func() bool {
		_, ok := f.item(t, id)
		_, err := os.Lstat(filepath.Join(f.heap, filepath.FromSlash(rel)))
		return !ok && errors.Is(err, os.ErrNotExist)
	})
}

func assertAllOK(t *testing.T, results []AssignResult, ids []int64) {
	t.Helper()
	if len(results) != len(ids) {
		t.Fatalf("results = %+v", results)
	}
	for index, result := range results {
		if result.ID != ids[index] || !result.OK || result.Error != nil || result.ImportJobID == nil {
			t.Fatalf("result %d = %+v", index, result)
		}
	}
}

func TestAssignImportsBooksOntoShelves(t *testing.T) {
	f := newAssignFixture(t)
	ctx := context.Background()
	shared := f.shelf(t, admin, catalog.ShelfInput{Kind: "shared", Name: "Shared"})
	private := f.shelf(t, admin, catalog.ShelfInput{Kind: "private", Name: "Mine"})
	names := []string{"one.epub", "sub/two.epub", "three.epub"}
	ids := f.items(t, names...)

	results, err := f.service.Assign(ctx, admin, ids, 1, []int64{shared, private})
	if err != nil {
		t.Fatal(err)
	}
	assertAllOK(t, results, ids)
	for _, id := range ids {
		item, _ := f.item(t, id)
		if item.Status != StatusQueued || item.TargetLibraryID == nil || *item.TargetLibraryID != 1 ||
			len(item.TargetShelfIDs) != 2 || item.ImportJobID == nil || item.Error != nil {
			t.Fatalf("queued item = %+v", item)
		}
	}
	f.start(t)
	for index, id := range ids {
		f.waitGone(t, id, names[index])
	}
	if books := f.count(t, `SELECT count(*) FROM books WHERE library_id = 1`); books != 3 {
		t.Fatalf("books = %d", books)
	}
	for _, shelfID := range []int64{shared, private} {
		if members := f.count(t, `SELECT count(*) FROM shelf_books WHERE shelf_id = ?`, shelfID); members != 3 {
			t.Fatalf("shelf %d has %d books", shelfID, members)
		}
	}
	if jobs := f.count(t, `SELECT count(*) FROM import_jobs WHERE source = 'bookheap' AND status = 'imported' AND user_id = 1`); jobs != 3 {
		t.Fatalf("imported bookheap jobs = %d", jobs)
	}
	history, err := f.importer.History(ctx, admin, 0, 10)
	if err != nil || len(history.Items) != 3 || history.Items[0].Source != ImportSource {
		t.Fatalf("history = %+v, %v", history, err)
	}
	if hits := f.count(t, `SELECT count(*) FROM books_fts`); hits != 3 {
		t.Fatalf("search rows = %d", hits)
	}
	if left := f.visibleFiles(t); len(left) != 1 || left[0] != "sub" {
		t.Fatalf("heap files = %v", left)
	}
}

func TestAssignDuplicateFailureAndRetry(t *testing.T) {
	f := newAssignFixture(t)
	ctx := context.Background()
	shelf := f.shelf(t, admin, catalog.ShelfInput{Kind: "shared", Name: "Shared"})
	ids := f.items(t, "dup.epub", "good.epub")
	f.write(t, "broken.epub", makeArchive(t, map[string][]byte{"mimetype": []byte("application/epub+zip")}), time.Hour)
	f.scan(t)
	var broken int64
	if err := f.db.Reader.QueryRow(`SELECT id FROM bookheap_items WHERE rel_path = 'broken.epub'`).Scan(&broken); err != nil {
		t.Fatal(err)
	}
	if item, _ := f.item(t, broken); item.Status != StatusReady {
		t.Fatalf("broken item = %+v", item)
	}
	dup, _ := f.item(t, ids[0])
	for _, statement := range []string{
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (77, 1, 'Existing', 'existing', 1, 1)`,
		`INSERT INTO book_files (book_id, sha256, format, size_bytes, original_filename, created_at) VALUES (77, '` + *dup.SHA256 + `', 'epub', 1, 'x.epub', 1)`,
		// A good item that failed earlier can be retried.
		`UPDATE bookheap_items SET status = 'failed', error = 'earlier failure' WHERE id = ` + strconv.FormatInt(ids[1], 10),
	} {
		if _, err := f.db.Writer.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	f.start(t)
	all := []int64{ids[0], ids[1], broken}
	results, err := f.service.Assign(ctx, admin, all, 1, []int64{shelf})
	if err != nil {
		t.Fatal(err)
	}
	assertAllOK(t, results, all)
	duplicate := f.waitStatus(t, ids[0], StatusDuplicate)
	if duplicate.DuplicateOfBookID == nil || *duplicate.DuplicateOfBookID != 77 {
		t.Fatalf("duplicate item = %+v", duplicate)
	}
	failed := f.waitStatus(t, broken, StatusFailed)
	if failed.Error == nil || *failed.Error == "" {
		t.Fatalf("failed item = %+v", failed)
	}
	f.waitGone(t, ids[1], "good.epub")
	for _, name := range []string{"dup.epub", "broken.epub"} {
		if _, err := os.Stat(filepath.Join(f.heap, name)); err != nil {
			t.Fatalf("%s was not kept: %v", name, err)
		}
	}
	if members := f.count(t, `SELECT count(*) FROM shelf_books WHERE shelf_id = ?`, shelf); members != 1 {
		t.Fatalf("shelf members = %d", members)
	}

	results, err = f.service.Assign(ctx, admin, []int64{broken, ids[0]}, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].OK || *results[0].ImportJobID == *failed.ImportJobID || results[1].OK || *results[1].Error != AssignNotAssignable {
		t.Fatalf("retry results = %+v", results)
	}
	eventually(t, "retry to fail", func() bool {
		item, _ := f.item(t, broken)
		return item.Status == StatusFailed && *item.ImportJobID == *results[0].ImportJobID
	})
}

func TestAssignRejectsWholeRequest(t *testing.T) {
	f := newAssignFixture(t)
	ctx := context.Background()
	reader := catalog.Viewer{UserID: 2}
	ids := f.items(t, "a.epub")
	shared := f.shelf(t, admin, catalog.ShelfInput{Kind: "shared", Name: "Shared"})
	other := f.shelf(t, reader, catalog.ShelfInput{Kind: "private", Name: "Theirs"})
	automatic := f.shelf(t, admin, catalog.ShelfInput{Kind: "private", Mode: catalog.ShelfModeAutomatic, Name: "Auto",
		Rules: &catalog.RuleSet{Match: "all", Conditions: []catalog.RuleCondition{{Field: "title", Op: "contains", Value: []byte(`"a"`)}}}})
	tooMany := make([]int64, MaxAssignIDs+1)
	for index := range tooMany {
		tooMany[index] = int64(index + 1)
	}
	for _, test := range []struct {
		name    string
		viewer  catalog.Viewer
		ids     []int64
		library int64
		shelves []int64
		want    error
		shelf   int64
	}{
		{"reader", reader, ids, 1, nil, catalog.ErrForbidden, 0},
		{"no ids", admin, nil, 1, nil, catalog.ErrInvalid, 0},
		{"too many ids", admin, tooMany, 1, nil, catalog.ErrInvalid, 0},
		{"duplicate ids", admin, []int64{ids[0], ids[0]}, 1, nil, catalog.ErrInvalid, 0},
		{"zero id", admin, []int64{0}, 1, nil, catalog.ErrInvalid, 0},
		{"duplicate shelves", admin, ids, 1, []int64{shared, shared}, catalog.ErrInvalid, 0},
		{"unshelved", admin, ids, 1, []int64{0}, catalog.ErrInvalid, 0},
		{"missing library", admin, ids, 99, nil, catalog.ErrNotFound, 0},
		{"missing shelf", admin, ids, 1, []int64{shared, 9999}, catalog.ErrNotFound, 9999},
		{"automatic shelf", admin, ids, 1, []int64{shared, automatic}, catalog.ErrConflict, automatic},
		{"other user's private shelf", admin, ids, 1, []int64{other}, catalog.ErrForbidden, other},
	} {
		_, err := f.service.Assign(ctx, test.viewer, test.ids, test.library, test.shelves)
		var shelfErr *ShelfError
		if !errors.Is(err, test.want) || test.shelf != 0 && (!errors.As(err, &shelfErr) || shelfErr.ShelfID != test.shelf) {
			t.Errorf("%s: err = %v", test.name, err)
		}
	}
	tooManyShelves := make([]int64, MaxAssignShelves+1)
	for index := range tooManyShelves {
		tooManyShelves[index] = int64(index + 1)
	}
	if _, err := f.service.Assign(ctx, admin, ids, 1, tooManyShelves); !errors.Is(err, catalog.ErrInvalid) {
		t.Fatalf("too many shelves: %v", err)
	}
	if jobs := f.count(t, `SELECT count(*) FROM import_jobs`); jobs != 0 {
		t.Fatalf("jobs = %d", jobs)
	}
	if item, _ := f.item(t, ids[0]); item.Status != StatusReady || item.ImportJobID != nil {
		t.Fatalf("item = %+v", item)
	}
	favorites, err := f.catalog.GetSystemShelf(ctx, admin, catalog.SystemShelfFavorites)
	if err != nil {
		t.Fatal(err)
	}
	if results, err := f.service.Assign(ctx, admin, ids, 1, []int64{*favorites.ShelfID, shared}); err != nil || !results[0].OK {
		t.Fatalf("favorites assignment = %+v, %v", results, err)
	}
}

func TestAssignPerItemCodes(t *testing.T) {
	f := newAssignFixture(t)
	ctx := context.Background()
	ids := f.items(t, "changed.epub", "missing.epub", "busy.epub")
	f.write(t, "invalid.epub", []byte("not a book"), time.Hour)
	f.scan(t)
	var invalid int64
	if err := f.db.Reader.QueryRow(`SELECT id FROM bookheap_items WHERE status = 'invalid'`).Scan(&invalid); err != nil {
		t.Fatal(err)
	}
	f.write(t, "changed.epub", testEPUB(t, "different"), time.Hour)
	if err := os.Remove(filepath.Join(f.heap, "missing.epub")); err != nil {
		t.Fatal(err)
	}
	request := []int64{ids[0], ids[1], invalid, 9999, ids[2]}
	results, err := f.service.Assign(ctx, admin, request, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{AssignChanged, AssignChanged, AssignNotAssignable, AssignNotFound, ""}
	for index, result := range results {
		code := ""
		if result.Error != nil {
			code = *result.Error
		}
		if result.ID != request[index] || code != want[index] || result.OK != (code == "") || (result.ImportJobID != nil) != result.OK {
			t.Fatalf("result %d = %+v", index, result)
		}
	}
	changed, _ := f.item(t, ids[0])
	if changed.Status != StatusReady || changed.Error == nil || *changed.Error != changedMessage {
		t.Fatalf("changed item = %+v", changed)
	}
	if again, err := f.service.Assign(ctx, admin, []int64{ids[2]}, 1, nil); err != nil || again[0].OK || *again[0].Error != AssignNotAssignable {
		t.Fatalf("busy item = %+v, %v", again, err)
	}
	if deleted, err := f.service.Delete(ctx, admin, []int64{ids[2]}); err != nil || *deleted[0].Error != DeleteBusy {
		t.Fatalf("delete busy item = %+v, %v", deleted, err)
	}
	f.scan(t)
	if item, ok := f.item(t, ids[2]); !ok || item.Status != StatusQueued {
		t.Fatalf("scan changed queued item: %+v", item)
	}
	if _, ok := f.item(t, ids[1]); ok {
		t.Fatal("scan kept the missing item")
	}
	if jobs := f.count(t, `SELECT count(*) FROM import_jobs`); jobs != 1 {
		t.Fatalf("jobs = %d", jobs)
	}
	if staged := f.count(t, `SELECT count(*) FROM import_jobs WHERE status = 'pending'`); staged != 1 {
		t.Fatalf("pending jobs = %d", staged)
	}
	entries, err := os.ReadDir(filepath.Join(f.root, "tmp", "imports"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("manifests = %v, %v", entries, err)
	}
}

func TestAssignConcurrentQueuesOnce(t *testing.T) {
	f := newAssignFixture(t)
	ids := f.items(t, "race.epub")
	var wait sync.WaitGroup
	results := make([][]AssignResult, 4)
	for index := range results {
		wait.Add(1)
		go func() {
			defer wait.Done()
			var err error
			results[index], err = f.service.Assign(context.Background(), admin, ids, 1, nil)
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wait.Wait()
	ok := 0
	for _, result := range results {
		if len(result) == 1 && result[0].OK {
			ok++
		} else if len(result) != 1 || result[0].Error == nil || *result[0].Error != AssignNotAssignable {
			t.Fatalf("result = %+v", result)
		}
	}
	if ok != 1 {
		t.Fatalf("%d assignments succeeded", ok)
	}
	if jobs := f.count(t, `SELECT count(*) FROM import_jobs`); jobs != 1 {
		t.Fatalf("jobs = %d", jobs)
	}
	entries, err := os.ReadDir(filepath.Join(f.root, "tmp", "imports"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("manifests = %v, %v", entries, err)
	}
}

// Regression: workers looked up hooks under the importer lock while holding the writer
// transaction, and enqueue held that lock while waiting for the writer, so a large assign
// with running workers deadlocked.
func TestAssignWhileImporterRuns(t *testing.T) {
	f := newAssignFixture(t)
	f.start(t)
	shelf := f.shelf(t, admin, catalog.ShelfInput{Kind: "private", Name: "Live"})
	names := make([]string, 0, 150)
	for index := range 150 {
		names = append(names, "live-"+strconv.Itoa(index)+".epub")
	}
	ids := f.items(t, names...)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	results, err := f.service.Assign(ctx, admin, ids, 1, []int64{shelf})
	if err != nil {
		t.Fatal(err)
	}
	assertAllOK(t, results, ids)
	for index, id := range ids {
		f.waitGone(t, id, names[index])
	}
}

func TestAssignRecoversAfterRestart(t *testing.T) {
	databases, blobs, root := openAssignDB(t)
	first := newAssignServices(t, databases, blobs, root)
	shelf := first.shelf(t, admin, catalog.ShelfInput{Kind: "shared", Name: "Shared"})
	names := []string{"pending.epub", "finished.epub", "lost.epub"}
	ids := first.items(t, names...)
	results, err := first.service.Assign(context.Background(), admin, ids, 1, []int64{shelf})
	if err != nil {
		t.Fatal(err)
	}
	assertAllOK(t, results, ids)
	stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := first.importer.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	jobs := make([]string, len(results))
	for index, result := range results {
		jobs[index] = strconv.FormatInt(*result.ImportJobID, 10)
	}
	for _, statement := range []string{
		// The worker had claimed this job when the process stopped.
		`UPDATE bookheap_items SET status = 'importing' WHERE import_job_id = ` + jobs[0],
		`UPDATE import_jobs SET status = 'processing' WHERE id = ` + jobs[0],
		// This job failed, but the process stopped before the heap item was updated.
		`UPDATE import_jobs SET status = 'failed', error = 'boom', finished_at = 1 WHERE id = ` + jobs[1],
		// This job's row and manifest disappeared.
		`DELETE FROM import_jobs WHERE id = ` + jobs[2],
	} {
		if _, err := databases.Writer.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Remove(filepath.Join(root, "tmp", "imports", jobs[2]+".json")); err != nil {
		t.Fatal(err)
	}

	second := newAssignServices(t, databases, blobs, root)
	second.start(t)
	second.waitGone(t, ids[0], names[0])
	failed := second.waitStatus(t, ids[1], StatusFailed)
	if failed.Error == nil || *failed.Error != "boom" {
		t.Fatalf("finished item = %+v", failed)
	}
	lost := second.waitStatus(t, ids[2], StatusFailed)
	if lost.Error == nil || *lost.Error != lostJobMessage {
		t.Fatalf("lost item = %+v", lost)
	}
	for _, name := range names[1:] {
		if _, err := os.Stat(filepath.Join(second.heap, name)); err != nil {
			t.Fatalf("%s was not kept: %v", name, err)
		}
	}
	if members := second.count(t, `SELECT count(*) FROM shelf_books WHERE shelf_id = ?`, shelf); members != 1 {
		t.Fatalf("shelf members = %d", members)
	}
	results, err = second.service.Assign(context.Background(), admin, ids[1:], 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertAllOK(t, results, ids[1:])
	for index, id := range ids[1:] {
		second.waitGone(t, id, names[index+1])
	}
	eventually(t, "manifests to be removed", func() bool {
		entries, err := os.ReadDir(filepath.Join(root, "tmp", "imports"))
		return err == nil && len(entries) == 0
	})
}

func TestAssignFinishedImportRemovesFileOnRestart(t *testing.T) {
	databases, blobs, root := openAssignDB(t)
	first := newAssignServices(t, databases, blobs, root)
	ids := first.items(t, "book.epub")
	results, err := first.service.Assign(context.Background(), admin, ids, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	job := *results[0].ImportJobID
	// Simulate a crash after the book committed but before the heap file was removed.
	err = db.WithTx(context.Background(), databases.Writer, func(tx *sql.Tx) error {
		statements := []string{
			`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (50, 1, 'Book', 'book', 1, 1)`,
			`DELETE FROM bookheap_items WHERE import_job_id = ?`,
			`UPDATE import_jobs SET status = 'imported', book_id = 50, finished_at = 1 WHERE id = ?`,
		}
		for index, statement := range statements {
			var args []any
			if index > 0 {
				args = []any{job}
			}
			if _, err := tx.Exec(statement, args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := first.importer.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	second := newAssignServices(t, databases, blobs, root)
	second.start(t)
	eventually(t, "heap file removal", func() bool {
		_, err := os.Lstat(filepath.Join(second.heap, "book.epub"))
		entries, _ := os.ReadDir(filepath.Join(root, "tmp", "imports"))
		return errors.Is(err, os.ErrNotExist) && len(entries) == 0
	})
}
