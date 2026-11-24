package trash

import (
	"context"
	"errors"
	"testing"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

func fixture(t *testing.T) (*Service, *db.DB) {
	t.Helper()
	ctx := context.Background()
	d, err := db.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	r, err := migrations.NewRunner(d.Writer, ":memory:", migrations.Files(), migrations.Options{AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Run(ctx); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES (1,'admin','x','admin',1,1),(2,'reader','x','user',1,1),(3,'other','x','user',1,1)`,
		`INSERT INTO libraries(id,name,slug,created_at,updated_at) VALUES (1,'Library','library',1,1)`,
		`INSERT INTO library_access(library_id,user_id,granted_at) VALUES (1,2,1)`,
		`INSERT INTO books(id,library_id,title,sort_title,created_at,updated_at,deleted_at) VALUES (1,1,'Deleted book','deleted book',1,1,123), (2,1,'Active book','active book',1,1,NULL)`,
		`INSERT INTO book_files(id,book_id,sha256,format,size_bytes,original_filename,created_at) VALUES (1,1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','epub',1,'book.epub',1), (2,2,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','pdf',2,'active.pdf',1)`,
		`INSERT INTO wordbooks(id,user_id,name,created_at,updated_at,deleted_at) VALUES (1,2,'Deleted words','x','x',123), (2,2,'Active words','x','x',NULL), (3,3,'Private words','x','x',123), (4,2,'Other trash','x','x',456)`,
		`INSERT INTO wordbook_entries(id,wordbook_id,kind,text,dictionary_entries,source,created_at,updated_at) VALUES (1,1,'word','kept','[]','{}','x','x')`,
		`INSERT INTO highlights(id,user_id,book_id,locator,text,created_at,updated_at,deleted_at,rev) VALUES ('00000000-0000-0000-0000-000000000001',2,2,'{}','Deleted highlight',1,2,3,1)`,
		`INSERT INTO bookmarks(id,user_id,book_id,locator,label,created_at,updated_at,deleted_at,rev) VALUES ('00000000-0000-0000-0000-000000000002',2,2,'{}','Deleted bookmark',1,2,3,1)`,
	} {
		if _, err := d.Writer.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	return NewService(d.Writer), d
}

func TestListOwnershipFilteringAndAtomicRestore(t *testing.T) {
	s, d := fixture(t)
	ctx := context.Background()
	reader := catalog.Viewer{UserID: 2}
	items, err := s.List(ctx, reader, "", "")
	if err != nil || len(items) != 3 {
		t.Fatalf("list = %+v, %v", items, err)
	}
	for _, ref := range []Ref{
		{Type: "annotation", ID: "bookmark:00000000-0000-0000-0000-000000000002"},
		{Type: "wordbook", ID: "entry:1"},
	} {
		if err := s.Apply(ctx, reader, []Ref{ref}, true); !errors.Is(err, catalog.ErrInvalid) {
			t.Fatalf("unsupported item %+v: %v", ref, err)
		}
	}
	items, err = s.List(ctx, reader, "wordbook", "DELETED")
	if err != nil || len(items) != 1 || items[0].ID != "1" {
		t.Fatalf("filtered = %+v, %v", items, err)
	}
	if err := s.Apply(ctx, reader, []Ref{{Type: "wordbook", ID: "1"}, {Type: "wordbook", ID: "3"}}, true); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("unauthorized batch = %v", err)
	}
	var deleted int64
	if err := d.Reader.QueryRowContext(ctx, `SELECT deleted_at FROM wordbooks WHERE id=1`).Scan(&deleted); err != nil || deleted != 123 {
		t.Fatalf("batch was not rolled back: %d %v", deleted, err)
	}
	if err := s.Apply(ctx, reader, []Ref{{Type: "book", ID: "1"}}, true); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatalf("non-admin book restore = %v", err)
	}
	if err := s.Apply(ctx, reader, []Ref{{Type: "wordbook", ID: "1"}}, true); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := d.Reader.QueryRowContext(ctx, `SELECT count(*) FROM wordbook_entries WHERE wordbook_id=1`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("entries restored = %d, %v", count, err)
	}
}

func TestBookAndAnnotationRestoreAndPurge(t *testing.T) {
	s, d := fixture(t)
	ctx := context.Background()
	admin := catalog.Viewer{UserID: 1, IsAdmin: true}
	reader := catalog.Viewer{UserID: 2}
	book := Ref{Type: "book", ID: "1"}
	if err := s.Apply(ctx, admin, []Ref{book}, true); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := d.Reader.QueryRowContext(ctx, `SELECT count(*) FROM active_books b JOIN book_files f ON f.book_id=b.id WHERE b.id=1`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("book files missing after restore: %d %v", count, err)
	}
	if _, err := d.Writer.ExecContext(ctx, `UPDATE books SET deleted_at=999 WHERE id=1; DELETE FROM books_fts WHERE rowid=1`); err != nil {
		t.Fatal(err)
	}
	if err := s.Apply(ctx, admin, []Ref{book}, false); err != nil {
		t.Fatal(err)
	}
	if err := d.Reader.QueryRowContext(ctx, `SELECT count(*) FROM book_files WHERE book_id=1`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("book purge did not cascade: %d %v", count, err)
	}
	ref := Ref{Type: "annotation", ID: "highlight:00000000-0000-0000-0000-000000000001"}
	if err := s.Apply(ctx, reader, []Ref{ref}, true); err != nil {
		t.Fatal(err)
	}
	if err := d.Reader.QueryRowContext(ctx, `SELECT count(*) FROM highlights_fts WHERE text='Deleted highlight'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("highlight not reindexed: %d %v", count, err)
	}
	if _, err := d.Writer.ExecContext(ctx, `UPDATE highlights SET deleted_at=5 WHERE user_id=2; DELETE FROM highlights_fts`); err != nil {
		t.Fatal(err)
	}
	if err := s.Apply(ctx, reader, []Ref{ref}, false); err != nil {
		t.Fatal(err)
	}
	var text string
	var purged int
	if err := d.Reader.QueryRowContext(ctx, `SELECT text,purged FROM highlights WHERE user_id=2`).Scan(&text, &purged); err != nil || text != "" || purged != 1 {
		t.Fatalf("sync tombstone not scrubbed: %q %d %v", text, purged, err)
	}
	if err := s.Apply(ctx, reader, []Ref{ref}, true); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("purged item restored: %v", err)
	}
}

func TestFileRestoreAndPurge(t *testing.T) {
	s, d := fixture(t)
	ctx := context.Background()
	admin := catalog.Viewer{UserID: 1, IsAdmin: true}
	reader := catalog.Viewer{UserID: 2}
	ref := Ref{Type: "file", ID: "2"}

	if err := s.Apply(ctx, reader, []Ref{ref}, true); !errors.Is(err, catalog.ErrForbidden) {
		t.Fatalf("non-admin file restore = %v", err)
	}
	if _, err := d.Writer.ExecContext(ctx, `UPDATE book_files SET deleted_at = 123 WHERE id = 2`); err != nil {
		t.Fatal(err)
	}
	items, err := s.List(ctx, admin, "file", "")
	if err != nil || len(items) != 1 || items[0].ID != "2" || items[0].Title != "active.pdf" || items[0].Subtitle != "Active book · PDF" {
		t.Fatalf("file trash list = %+v, %v", items, err)
	}
	if err := s.Apply(ctx, admin, []Ref{ref}, true); err != nil {
		t.Fatal(err)
	}
	var deletedAt int64
	if err := d.Reader.QueryRowContext(ctx, `SELECT COALESCE(deleted_at, 0) FROM book_files WHERE id = 2`).Scan(&deletedAt); err != nil || deletedAt != 0 {
		t.Fatalf("file restore = %d, %v", deletedAt, err)
	}
	if err := s.Apply(ctx, admin, []Ref{ref}, true); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("second file restore = %v", err)
	}
	if _, err := d.Writer.ExecContext(ctx, `UPDATE book_files SET deleted_at = 456 WHERE id = 2`); err != nil {
		t.Fatal(err)
	}
	if err := s.Apply(ctx, admin, []Ref{ref}, false); err != nil {
		t.Fatal(err)
	}
	var files, books int
	if err := d.Reader.QueryRowContext(ctx, `SELECT count(*) FROM book_files WHERE id = 2`).Scan(&files); err != nil || files != 0 {
		t.Fatalf("file purge left %d rows, %v", files, err)
	}
	if err := d.Reader.QueryRowContext(ctx, `SELECT count(*) FROM books WHERE id = 2`).Scan(&books); err != nil || books != 1 {
		t.Fatalf("file purge removed parent book: %d, %v", books, err)
	}
}

func TestMutationFailureRollsBackBatch(t *testing.T) {
	s, d := fixture(t)
	ctx := context.Background()
	if _, err := d.Writer.ExecContext(ctx, `CREATE TRIGGER reject_trash_delete BEFORE DELETE ON wordbooks WHEN OLD.id=4
		BEGIN SELECT RAISE(ABORT, 'delete failed'); END`); err != nil {
		t.Fatal(err)
	}
	err := s.Apply(ctx, catalog.Viewer{UserID: 2}, []Ref{
		{Type: "wordbook", ID: "1"}, {Type: "wordbook", ID: "4"},
	}, false)
	if err == nil {
		t.Fatal("expected delete failure")
	}
	var count int
	if err := d.Reader.QueryRowContext(ctx, `SELECT count(*) FROM wordbooks WHERE id=1 AND deleted_at IS NOT NULL`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("batch rollback = %d, %v", count, err)
	}
}
