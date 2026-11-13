package importer

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
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
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/extract"
)

type fixture struct {
	service *Service
	db      *db.DB
	blobs   *blobstore.Store
	root    string
}

var admin = catalog.Viewer{UserID: 1, IsAdmin: true}

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
		`INSERT INTO libraries (id,name,slug,created_at,updated_at) VALUES (1,'Main','main',1,1),(2,'Other','other',1,1)`,
		`INSERT INTO server_settings (key,value,updated_at) VALUES ('default_library_id','1',1)`,
	} {
		if _, err := databases.Writer.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	blobs, err := blobstore.New(root)
	if err != nil {
		t.Fatal(err)
	}
	catalogService, err := catalog.NewService(databases.Writer, databases.Reader, blobs)
	if err != nil {
		t.Fatal(err)
	}
	service, err := New(Options{Writer: databases.Writer, Reader: databases.Reader, Blobs: blobs, Catalog: catalogService,
		DataDir: root, DropDir: filepath.Join(root, "drop"), MaxBytes: 2 << 20, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := service.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	return fixture{service, databases, blobs, root}
}

func (f fixture) queue(t *testing.T, data []byte, name string) Job {
	t.Helper()
	staged, err := f.service.Stage(context.Background(), bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	job, err := f.service.QueueUpload(context.Background(), admin, 1, 0, name, staged)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func (f fixture) wait(t *testing.T, id int64) sqlc.ImportJob {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		row, err := sqlc.New(f.db.Reader).ImportJob(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if row.Status != "pending" && row.Status != "processing" {
			return row
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("job did not finish", id)
		}
	}
}

func makeArchive(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for name, data := range files {
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

func testCover(t *testing.T) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := png.Encode(&output, image.NewRGBA(image.Rect(0, 0, 4, 8))); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func testEPUB(t *testing.T) []byte {
	t.Helper()
	files := map[string][]byte{"mimetype": []byte("application/epub+zip"), "OPS/cover.png": testCover(t)}
	for _, item := range []struct{ source, target string }{{"container.xml", "META-INF/container.xml"}, {"package.opf", "OPS/package.opf"}} {
		data, err := os.ReadFile(filepath.Join("..", "extract", "testdata", "epub2", item.source))
		if err != nil {
			t.Fatal(err)
		}
		files[item.target] = data
	}
	return makeArchive(t, files)
}

func TestImportSkipsUnsupportedIdentifierSchemes(t *testing.T) {
	f := newFixture(t)
	files := map[string][]byte{"mimetype": []byte("application/epub+zip"), "OPS/cover.png": testCover(t)}
	container, err := os.ReadFile(filepath.Join("..", "extract", "testdata", "epub2", "container.xml"))
	if err != nil {
		t.Fatal(err)
	}
	opf, err := os.ReadFile(filepath.Join("..", "extract", "testdata", "epub2", "package.opf"))
	if err != nil {
		t.Fatal(err)
	}
	files["META-INF/container.xml"] = container
	files["OPS/package.opf"] = bytes.Replace(opf, []byte("<dc:subject>"), []byte(
		`<dc:identifier>http://www.gutenberg.org/11</dc:identifier>`+
			`<dc:identifier opf:scheme="calibre">abc</dc:identifier>`+
			`<dc:identifier>urn:uuid:0b3e8f4c-1111-4222-8333-944455556666</dc:identifier>`+
			`<dc:subject>`), 1)
	job := f.queue(t, makeArchive(t, files), "pg11-images-3.epub")
	if err := f.service.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	row := f.wait(t, job.ID)
	if row.Status != "imported" {
		t.Fatalf("job: %+v", row)
	}
	book, err := f.service.options.Catalog.GetBook(context.Background(), admin, row.BookID.Int64)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, identifier := range book.Identifiers {
		got[identifier.Scheme] = identifier.Value
	}
	if len(got) != 2 || got["isbn13"] != "9780306406157" || got["uuid"] != "0b3e8f4c-1111-4222-8333-944455556666" {
		t.Fatalf("identifiers: %+v", book.Identifiers)
	}
}

func TestImportAtomicMetadataCoverAndConcurrentDuplicate(t *testing.T) {
	f := newFixture(t)
	data := testEPUB(t)
	var jobs []Job
	for range 8 {
		jobs = append(jobs, f.queue(t, data, "The book.epub"))
	}
	if err := f.service.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	imported, duplicates := 0, 0
	var bookID int64
	for _, job := range jobs {
		row := f.wait(t, job.ID)
		switch row.Status {
		case "imported":
			imported++
			bookID = row.BookID.Int64
		case "duplicate":
			duplicates++
			if !row.DuplicateOfBookID.Valid {
				t.Fatal("missing duplicate reference")
			}
		default:
			t.Fatalf("job: %+v", row)
		}
	}
	if imported != 1 || duplicates != 7 {
		t.Fatalf("outcomes: imported %d duplicate %d", imported, duplicates)
	}
	book, err := f.service.options.Catalog.GetBook(context.Background(), admin, bookID)
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "The Fixture Book" || book.SortTitle != catalog.SortTitle(book.Title) || len(book.Authors) != 2 || book.Authors[1].Role != "translator" ||
		book.Series == nil || *book.Series.Index != 2.5 || len(book.Tags) != 1 || len(book.Identifiers) != 1 || book.CoverURL == nil || len(book.FieldSources) < 8 {
		t.Fatalf("book: %+v", book)
	}
	var count int
	if err := f.db.Reader.QueryRow(`SELECT count(*) FROM books_fts WHERE books_fts MATCH 'Fixture'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("FTS: %d %v", count, err)
	}
	var hash string
	if err := f.db.Reader.QueryRow(`SELECT cover_sha256 FROM books WHERE id = ?`, bookID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	for _, thumb := range []bool{false, true} {
		file, err := f.blobs.OpenCover(hash, thumb)
		if err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	page, err := f.service.History(context.Background(), admin, 0, 3)
	if err != nil || len(page.Items) != 3 || page.NextCursor == nil {
		t.Fatalf("history: %+v %v", page, err)
	}
}

func TestIdenticalImportsAreScopedToOwningLibrary(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	data := []byte(`<FictionBook><description><title-info><book-title>Shared bytes</book-title></title-info></description></FictionBook>`)
	var jobs []Job
	for range 4 {
		for _, libraryID := range []int64{1, 2} {
			staged, err := f.service.Stage(ctx, bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			job, err := f.service.QueueUpload(ctx, admin, libraryID, 0, "book.fb2", staged)
			if err != nil {
				t.Fatal(err)
			}
			jobs = append(jobs, job)
		}
	}
	if err := f.service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	books := make(map[int64]int64)
	imported, duplicates := 0, 0
	for _, job := range jobs {
		row := f.wait(t, job.ID)
		var bookID int64
		switch row.Status {
		case "imported":
			imported++
			bookID = row.BookID.Int64
			books[job.LibraryID] = bookID
		case "duplicate":
			duplicates++
			bookID = row.DuplicateOfBookID.Int64
		default:
			t.Fatalf("job failed: %+v", row)
		}
		var libraryID int64
		if err := f.db.Reader.QueryRow(`SELECT library_id FROM books WHERE id = ?`, bookID).Scan(&libraryID); err != nil || libraryID != job.LibraryID {
			t.Fatalf("job library=%d resolved to library=%d: %v", job.LibraryID, libraryID, err)
		}
	}
	if imported != 2 || duplicates != 6 || books[1] == books[2] {
		t.Fatalf("imported=%d duplicates=%d books=%v", imported, duplicates, books)
	}
	var hash string
	if err := f.db.Reader.QueryRow(`SELECT sha256 FROM book_files WHERE book_id = ?`, books[1]).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if err := f.service.options.Catalog.DeleteBook(ctx, admin, books[1]); err != nil {
		t.Fatal(err)
	}
	remaining, err := f.service.options.Catalog.GetBook(ctx, admin, books[2])
	if err != nil || remaining.LibraryID != 2 || len(remaining.Files) != 1 {
		t.Fatalf("other library copy changed: %+v, %v", remaining, err)
	}
	file, err := f.blobs.OpenBook(hash, "fb2")
	if err != nil {
		t.Fatalf("shared blob removed: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Writer.Exec(`INSERT INTO books (id,library_id,title,sort_title,created_at,updated_at)
		VALUES (100,1,'Attachment target','attachment target',1,1)`); err != nil {
		t.Fatal(err)
	}
	staged, err := f.service.Stage(ctx, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	job, err := f.service.QueueUpload(ctx, admin, 1, 100, "attached.fb2", staged)
	if err != nil {
		t.Fatal(err)
	}
	if row := f.wait(t, job.ID); row.Status != "imported" || row.BookID.Int64 != 100 {
		t.Fatalf("another library's copy claimed attachment: %+v", row)
	}
}

func TestRollbackAndCorruptInput(t *testing.T) {
	f := newFixture(t)
	if _, err := f.db.Writer.Exec(`CREATE TRIGGER reject_import_file BEFORE INSERT ON book_files BEGIN SELECT RAISE(ABORT,'forced rollback'); END`); err != nil {
		t.Fatal(err)
	}
	job := f.queue(t, testEPUB(t), "rollback.epub")
	corrupt := f.queue(t, []byte("not a book"), "bad.epub")
	if err := f.service.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{job.ID, corrupt.ID} {
		if row := f.wait(t, id); row.Status != "failed" {
			t.Fatalf("job: %+v", row)
		}
	}
	for _, table := range []string{"books", "authors", "series", "tags", "book_files", "book_field_sources", "books_fts"} {
		var count int
		if err := f.db.Reader.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s count %d %v", table, count, err)
		}
	}
}

func TestDurableRecoveryAndCancellation(t *testing.T) {
	f := newFixture(t)
	job := f.queue(t, testEPUB(t), "recover.epub")
	if _, err := sqlc.New(f.db.Writer).ImportClaim(context.Background()); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(f.service.options)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	row := f.wait(t, job.ID)
	if row.Status != "imported" {
		t.Fatalf("recovered job: %+v", row)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := restarted.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Stage(ctx, strings.NewReader("x")); !errors.Is(err, ErrStopped) {
		t.Fatalf("accepted after stop: %v", err)
	}
}

func TestLimitsNamesAndAuthorization(t *testing.T) {
	f := newFixture(t)
	f.service.options.MaxBytes = 16
	if _, err := f.service.Stage(context.Background(), strings.NewReader(strings.Repeat("x", 17))); !errors.Is(err, catalog.ErrTooLarge) {
		t.Fatal(err)
	}
	staged, err := f.service.Stage(context.Background(), strings.NewReader("test"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := f.service.Discard(staged); err != nil {
			t.Error(err)
		}
	}()
	if _, err := f.service.QueueUpload(context.Background(), catalog.Viewer{UserID: 1}, 1, 0, "book.epub", staged); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatal(err)
	}
	for _, name := range []string{"", "../evil", `a\b.epub`, "file\r\n.epub", "file:stream", ".", "..", strings.Repeat("x", 256)} {
		if ValidFilename(name) {
			t.Errorf("accepted %q", name)
		}
	}
	if !ValidFilename("The Book.epub") {
		t.Fatal("rejected display name with spaces")
	}
}

func minimalMOBI(version uint32) []byte {
	data := make([]byte, 88+16+232)
	copy(data[60:68], "BOOKMOBI")
	binary.BigEndian.PutUint16(data[76:78], 1)
	binary.BigEndian.PutUint32(data[78:82], 88)
	binary.BigEndian.PutUint16(data[88:90], 1)
	copy(data[104:108], "MOBI")
	binary.BigEndian.PutUint32(data[108:112], 232)
	binary.BigEndian.PutUint32(data[116:120], 65001)
	binary.BigEndian.PutUint32(data[124:128], version)
	return data
}

func minimalPDF() []byte {
	objects := []string{`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>`, "<< /Length 0 >>\nstream\n\nendstream"}
	var output bytes.Buffer
	output.WriteString("%PDF-1.7\n")
	offsets := []int{0}
	for index, object := range objects {
		offsets = append(offsets, output.Len())
		fmt.Fprintf(&output, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xref := output.Len()
	fmt.Fprintf(&output, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&output, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&output, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	return output.Bytes()
}

func TestEveryDispatchableFormatUsesImporterRegistry(t *testing.T) {
	f := newFixture(t)
	fb2 := []byte(`<FictionBook><description><title-info><book-title>Fixture</book-title></title-info></description></FictionBook>`)
	formats := map[extract.Format][]byte{extract.FormatEPUB: testEPUB(t), extract.FormatPDF: minimalPDF(), extract.FormatMOBI: minimalMOBI(6),
		extract.FormatAZW3: minimalMOBI(8), extract.FormatFB2: fb2, extract.FormatFBZ: makeArchive(t, map[string][]byte{"book.fb2": fb2}),
		extract.FormatCBZ: makeArchive(t, map[string][]byte{"001.png": testCover(t)})}
	for format, data := range formats {
		t.Run(string(format), func(t *testing.T) {
			detected, err := extract.Sniff(bytes.NewReader(data), int64(len(data)))
			if err != nil || detected != format {
				t.Fatalf("sniff %s %v", detected, err)
			}
			if _, err := f.service.registry.Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "fixture."+string(format)); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, test := range []struct {
		name string
		data []byte
	}{
		{name: "UTF-8 BOM", data: append([]byte{0xef, 0xbb, 0xbf}, fb2...)},
		{name: "Windows-1251 declaration", data: []byte(`<?xml version="1.0" encoding="windows-1251"?><FictionBook><description><title-info><book-title>Fixture</book-title></title-info></description></FictionBook>`)},
	} {
		t.Run("plain FB2 "+test.name, func(t *testing.T) {
			if _, err := f.service.registry.Extract(context.Background(), bytes.NewReader(test.data), int64(len(test.data)), "fixture.fb2"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestConcurrentQueuePersistence(t *testing.T) {
	f := newFixture(t)
	var wait sync.WaitGroup
	for range 5 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			staged, err := f.service.Stage(context.Background(), strings.NewReader("invalid ebook"))
			if err != nil {
				t.Error(err)
				return
			}
			if _, err := f.service.QueueUpload(context.Background(), admin, 1, 0, "file.epub", staged); err != nil {
				t.Error(err)
			}
		}()
	}
	wait.Wait()
	var count int
	if err := f.db.Reader.QueryRow(`SELECT count(*) FROM import_jobs WHERE status='pending'`).Scan(&count); err != nil || count != 5 {
		t.Fatalf("durable queue count %d %v", count, err)
	}
}

func TestDuplicateRaceInsideTransaction(t *testing.T) {
	f := newFixture(t)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	f.service.registry = extract.NewRegistry(time.Second)
	if err := f.service.registry.Register(extract.FormatEPUB, func(ctx context.Context, _ io.ReaderAt, _ int64, _ string) (extract.Metadata, error) {
		entered <- struct{}{}
		select {
		case <-release:
			return extract.Metadata{Title: "Race Fixture"}, nil
		case <-ctx.Done():
			return extract.Metadata{}, ctx.Err()
		}
	}); err != nil {
		t.Fatal(err)
	}
	first := f.queue(t, testEPUB(t), "first.epub")
	input, err := f.service.readManifest(first.ID)
	if err != nil {
		t.Fatal(err)
	}
	file, err := f.blobs.OpenStaged(input.Staged.Token)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(file)
	if closeErr := file.Close(); err != nil || closeErr != nil {
		t.Fatal(err, closeErr)
	}
	second := f.queue(t, data, "second.epub")
	if err := f.service.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("both jobs did not pass the early duplicate check")
		}
	}
	close(release)
	statuses := map[string]int{f.wait(t, first.ID).Status: 1}
	statuses[f.wait(t, second.ID).Status]++
	if statuses["imported"] != 1 || statuses["duplicate"] != 1 {
		t.Fatalf("concurrent outcomes %v", statuses)
	}
}

func TestCancellationPreservesActiveJobForRestart(t *testing.T) {
	f := newFixture(t)
	entered := make(chan struct{})
	f.service.registry = extract.NewRegistry(time.Minute)
	if err := f.service.registry.Register(extract.FormatEPUB, func(ctx context.Context, _ io.ReaderAt, _ int64, _ string) (extract.Metadata, error) {
		close(entered)
		<-ctx.Done()
		return extract.Metadata{}, ctx.Err()
	}); err != nil {
		t.Fatal(err)
	}
	job := f.queue(t, testEPUB(t), "cancel.epub")
	ctx, cancel := context.WithCancel(context.Background())
	if err := f.service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("job never entered extraction")
	}
	cancel()
	stopCtx, stopCancel := context.WithTimeout(context.Background(), time.Second)
	defer stopCancel()
	if err := f.service.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
	row, err := sqlc.New(f.db.Reader).ImportJob(context.Background(), job.ID)
	if err != nil || row.Status != "processing" {
		t.Fatalf("cancelled job was consumed: %+v %v", row, err)
	}
	restarted, err := New(f.service.options)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if row := f.wait(t, job.ID); row.Status != "imported" {
		t.Fatalf("restart: %+v", row)
	}
	if err := restarted.Stop(stopCtx); err != nil {
		t.Fatal(err)
	}
}

func TestAttachmentRejectsMovedTargetBeforeResolvingDuplicate(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	data := []byte(`<FictionBook><description><title-info/></description></FictionBook>`)
	staged, err := f.service.Stage(ctx, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Writer.Exec(`INSERT INTO books (id,library_id,title,sort_title,created_at,updated_at)
		VALUES (1,1,'Target','target',1,1),(2,1,'Duplicate','duplicate',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Writer.Exec(`INSERT INTO book_files (book_id,sha256,format,size_bytes,original_filename,created_at)
		VALUES (2,?,'fb2',?,'copy.fb2',1)`, staged.SHA256, staged.Size); err != nil {
		t.Fatal(err)
	}
	job, err := f.service.QueueUpload(ctx, admin, 1, 1, "attachment.fb2", staged)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.options.Catalog.UpdateBook(ctx, admin, 1, catalog.BookPatch{
		LibraryID: catalog.Optional[int64]{Set: true, Value: pointer(int64(2), true)},
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if row := f.wait(t, job.ID); row.Status != "failed" {
		t.Fatalf("moved target resolved in original library: %+v", row)
	}
}

func TestAttachmentRechecksVisibilityAtCommit(t *testing.T) {
	f := newFixture(t)
	if _, err := f.db.Writer.Exec(`INSERT INTO books (id,library_id,title,sort_title,created_at,updated_at) VALUES (1,1,'Existing','existing',1,1)`); err != nil {
		t.Fatal(err)
	}
	staged, err := f.service.Stage(context.Background(), strings.NewReader(`<FictionBook><description><title-info/></description></FictionBook>`))
	if err != nil {
		t.Fatal(err)
	}
	job, err := f.service.QueueUpload(context.Background(), admin, 1, 1, "attachment.fb2", staged)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Writer.Exec(`INSERT INTO book_hidden (user_id,book_id,hidden_by,created_at) VALUES (1,1,1,1)`); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if row := f.wait(t, job.ID); row.Status != "failed" {
		t.Fatalf("hidden target imported: %+v", row)
	}
	var count int
	if err := f.db.Reader.QueryRow(`SELECT count(*) FROM book_files`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("hidden attachment file count %d %v", count, err)
	}
}
