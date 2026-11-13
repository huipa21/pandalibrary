package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"pandalibrary/internal/db"
	"pandalibrary/internal/search"
)

func bookPatch(t *testing.T, data string) BookPatch {
	t.Helper()
	var patch BookPatch
	if err := json.Unmarshal([]byte(data), &patch); err != nil {
		t.Fatal(err)
	}
	return patch
}

func TestSortTitle(t *testing.T) {
	for _, test := range []struct {
		title string
		want  string
	}{
		{"The Great Gatsby", "great gatsby, the"},
		{"A 中国 History", "zhongguo history, a"},
		{"An Apple", "apple, an"},
		{"三体", "santi"},
		{"  The 三体 II  ", "santi ii, the"},
		{"Theodore", "theodore"},
		{"the", "the"},
	} {
		if got := SortTitle(test.title); got != test.want {
			t.Errorf("SortTitle(%q) = %q, want %q", test.title, got, test.want)
		}
	}
}

func TestUpdateBookMetadataProvenanceAndIndex(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO authors (id, name, sort_name, created_at) VALUES (3, 'Orphan', 'Orphan', 1);
		INSERT INTO book_authors (book_id, author_id, role, position) VALUES (101, 3, 'editor', 1);
		UPDATE book_field_sources SET source_ref = 'old-provider' WHERE book_id = 101 AND field = 'title'`); err != nil {
		t.Fatal(err)
	}
	patch := bookPatch(t, `{
		"title":"The 三体", "subtitle":"  new subtitle  ", "description":"A distant future",
		"language":"zh-Hans", "publisher":"Future Press", "published_date":"2024-02-29", "page_count":400,
		"series":{"name":"shared series","index":1.5},
		"authors":[{"name":"shared author","role":"author"},{"name":"Alice","role":"translator"}],
		"tags":["SHARED TAG","Space"], "identifiers":[{"scheme":"isbn13","value":" 978123 "}]
	}`)
	book, err := fixture.service.UpdateBook(ctx, admin, 101, patch)
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "The 三体" || book.SortTitle != "santi, the" || book.Subtitle == nil ||
		*book.Subtitle != "new subtitle" || book.Series == nil || book.Series.ID != 1 ||
		book.Series.Name != "Shared Series" || book.Series.Index == nil || *book.Series.Index != 1.5 {
		t.Fatalf("updated scalar fields = %+v", book)
	}
	if len(book.Authors) != 2 || book.Authors[0].ID != 1 || book.Authors[0].Name != "Shared Author" ||
		book.Authors[1].Name != "Alice" || book.Authors[1].Role != "translator" ||
		len(book.Tags) != 2 || book.Tags[0].ID != 1 || book.Tags[0].Name != "Shared Tag" ||
		len(book.Identifiers) != 1 || book.Identifiers[0].Value != "978123" {
		t.Fatalf("updated associations = %+v", book)
	}
	expectedFields := map[string]bool{
		"title": true, "subtitle": true, "description": true, "language": true, "publisher": true,
		"published_date": true, "page_count": true, "series": true, "authors": true,
		"tags": true, "identifiers": true,
	}
	for _, source := range book.FieldSources {
		if !expectedFields[source.Field] || source.Source != "manual" || source.SourceRef != nil ||
			source.ChosenBy == nil || *source.ChosenBy != 1 || source.ChosenAt.UnixMilli() != 123456789 {
			t.Errorf("unexpected field source %+v", source)
		}
		delete(expectedFields, source.Field)
	}
	if len(expectedFields) != 0 {
		t.Errorf("missing sources for %v", expectedFields)
	}
	var title, authors, series, tags, publisher, identifiers, description string
	if err := fixture.db.Reader.QueryRowContext(ctx, `
		SELECT title, authors, series, tags, publisher, identifiers, description FROM books_fts WHERE rowid = 101`).
		Scan(&title, &authors, &series, &tags, &publisher, &identifiers, &description); err != nil {
		t.Fatal(err)
	}
	if title != "The 三体" || authors != "Shared Author Alice" || series != "Shared Series" ||
		tags != "Shared Tag Space" || publisher != "Future Press" || identifiers != "978123" ||
		description != "A distant future" {
		t.Fatalf("indexed fields = %q %q %q %q %q %q %q", title, authors, series, tags, publisher, identifiers, description)
	}
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM authors WHERE id = 3`, 0)
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM authors WHERE id = 1`, 1)

	cleared, err := fixture.service.UpdateBook(ctx, admin, 101, bookPatch(t, `{
		"subtitle":null,"series":null,"page_count":null,"authors":[],"tags":[],"identifiers":[]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Title != book.Title || cleared.Subtitle != nil || cleared.Series != nil || cleared.PageCount != nil ||
		len(cleared.Authors) != 0 || len(cleared.Tags) != 0 || len(cleared.Identifiers) != 0 {
		t.Fatalf("cleared fields = %+v", cleared)
	}
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM authors WHERE name = 'Alice'`, 0)
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM authors WHERE id = 1`, 1)
	var indexedAuthors, indexedSeries, indexedTags, indexedIdentifiers string
	if err := fixture.db.Reader.QueryRowContext(ctx, `
		SELECT authors, series, tags, identifiers FROM books_fts WHERE rowid = 101`).
		Scan(&indexedAuthors, &indexedSeries, &indexedTags, &indexedIdentifiers); err != nil {
		t.Fatal(err)
	}
	if indexedAuthors != "" || indexedSeries != "" || indexedTags != "" || indexedIdentifiers != "" {
		t.Fatalf("cleared index = %q %q %q %q", indexedAuthors, indexedSeries, indexedTags, indexedIdentifiers)
	}
}

func TestBookPatchValidationAndRollback(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	for _, input := range []string{
		`{}`, `{"title":null}`, `{"title":"  "}`, `{"page_count":0}`, `{"published_date":"2023-02-29"}`,
		`{"series":{"name":"X","index":-1}}`, `{"authors":null}`,
		`{"authors":[{"name":"A","role":"invalid"}]}`,
		`{"authors":[{"name":"A","role":"author"},{"name":"a","role":"author"}]}`,
		`{"tags":["Tag","tag"]}`,
		`{"identifiers":[{"scheme":"unknown","value":"x"}]}`,
		`{"identifiers":[{"scheme":"isbn13","value":"x"},{"scheme":"isbn13","value":" x "}]}`,
	} {
		if _, err := fixture.service.UpdateBook(ctx, admin, 101, bookPatch(t, input)); !errors.Is(err, ErrInvalid) {
			t.Errorf("patch %s returned %v, want invalid", input, err)
		}
	}
	if err := db.WithTx(ctx, fixture.db.Writer, func(tx *sql.Tx) error { return search.IndexBook(ctx, tx, 101) }); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		CREATE TRIGGER fail_tag_source BEFORE INSERT ON book_field_sources
		WHEN NEW.field = 'tags' BEGIN SELECT RAISE(ABORT, 'forced failure'); END`); err != nil {
		t.Fatal(err)
	}
	_, err := fixture.service.UpdateBook(ctx, admin, 101, bookPatch(t, `{"title":"Changed title","tags":["Rollback Tag"]}`))
	if err == nil || !strings.Contains(err.Error(), "forced failure") {
		t.Fatalf("injected update error = %v", err)
	}
	var title, source, indexedTitle string
	if err := fixture.db.Reader.QueryRowContext(ctx, `
		SELECT b.title, s.source, f.title FROM books b
		JOIN book_field_sources s ON s.book_id = b.id AND s.field = 'title'
		JOIN books_fts f ON f.rowid = b.id WHERE b.id = 101`).Scan(&title, &source, &indexedTitle); err != nil {
		t.Fatal(err)
	}
	if title != "Tie A" || source != "file" || indexedTitle != "Tie A" {
		t.Fatalf("rollback state = %q %q %q", title, source, indexedTitle)
	}
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM tags WHERE name = 'Rollback Tag'`, 0)
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM book_tags WHERE book_id = 101 AND tag_id = 1`, 1)
}

func TestDeleteBookCascadesAndFTSRollback(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	var fileHash string
	if err := fixture.db.Reader.QueryRowContext(ctx, `SELECT sha256 FROM book_files WHERE id = 201`).Scan(&fileHash); err != nil {
		t.Fatal(err)
	}
	if err := db.WithTx(ctx, fixture.db.Writer, func(tx *sql.Tx) error {
		if err := search.IndexBook(ctx, tx, 101); err != nil {
			return err
		}
		return search.IndexBook(ctx, tx, 104)
	}); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO user_books (user_id, book_id, updated_at, rev) VALUES (2, 101, 1, 1), (3, 101, 1, 1)`,
		`INSERT INTO reading_progress (user_id, book_id, book_file_id, source, percentage, updated_at, rev)
			VALUES (2, 101, 201, 'web', 0.5, 1, 1)`,
		`INSERT INTO reading_sessions (id, user_id, book_id, source, started_at, ended_at, active_seconds, created_at)
			VALUES ('00000000-0000-0000-0000-000000000001', 2, 101, 'web', 1, 2, 1, 1)`,
		`INSERT INTO highlights (seq, id, user_id, book_id, locator, text, created_at, updated_at, rev) VALUES
			(11, '00000000-0000-0000-0000-000000000011', 2, 101, '{}', 'first highlight', 1, 1, 1),
			(12, '00000000-0000-0000-0000-000000000012', 2, 104, '{}', 'keep highlight', 1, 1, 1)`,
		`INSERT INTO notes (seq, id, user_id, book_id, highlight_id, body_md, created_at, updated_at, rev) VALUES
			(21, '00000000-0000-0000-0000-000000000021', 2, 101, NULL, 'direct note', 1, 1, 1),
			(22, '00000000-0000-0000-0000-000000000022', 2, 104, '00000000-0000-0000-0000-000000000011', 'linked note', 1, 1, 1),
			(23, '00000000-0000-0000-0000-000000000023', 2, 104, NULL, 'keep note', 1, 1, 1)`,
		`INSERT INTO highlights_fts (rowid, text, user_id, book_id) VALUES
			(11, 'first highlight', 2, 101), (12, 'keep highlight', 2, 104)`,
		`INSERT INTO notes_fts (rowid, body, highlight_text, user_id, book_id) VALUES
			(21, 'direct note', '', 2, 101), (22, 'linked note', 'first highlight', 2, 104),
			(23, 'keep note', '', 2, 104)`,
		`CREATE TRIGGER fail_book_delete BEFORE DELETE ON books WHEN OLD.id = 101
			BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END`,
	}
	for _, statement := range statements {
		if _, err := fixture.db.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.service.DeleteBook(ctx, admin, 101); err == nil || !strings.Contains(err.Error(), "forced delete failure") {
		t.Fatalf("injected delete error = %v", err)
	}
	for _, query := range []string{
		`SELECT count(*) FROM books WHERE id = 101`,
		`SELECT count(*) FROM books_fts WHERE rowid = 101`,
		`SELECT count(*) FROM highlights_fts WHERE rowid = 11`,
		`SELECT count(*) FROM notes_fts WHERE rowid = 21`,
		`SELECT count(*) FROM notes_fts WHERE rowid = 22`,
	} {
		assertCount(t, fixture.db.Reader, query, 1)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `DROP TRIGGER fail_book_delete`); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.DeleteBook(ctx, admin, 101); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`SELECT count(*) FROM books WHERE id = 101`,
		`SELECT count(*) FROM books_fts WHERE rowid = 101`,
		`SELECT count(*) FROM book_files WHERE book_id = 101`,
		`SELECT count(*) FROM user_books WHERE book_id = 101`,
		`SELECT count(*) FROM reading_progress WHERE book_id = 101`,
		`SELECT count(*) FROM reading_sessions WHERE book_id = 101`,
		`SELECT count(*) FROM highlights WHERE seq = 11`,
		`SELECT count(*) FROM highlights_fts WHERE rowid = 11`,
		`SELECT count(*) FROM notes WHERE seq IN (21, 22)`,
		`SELECT count(*) FROM notes_fts WHERE rowid IN (21, 22)`,
	} {
		assertCount(t, fixture.db.Reader, query, 0)
	}
	for _, query := range []string{
		`SELECT count(*) FROM books_fts WHERE rowid = 104`,
		`SELECT count(*) FROM highlights_fts WHERE rowid = 12`,
		`SELECT count(*) FROM notes_fts WHERE rowid = 23`,
		`SELECT count(*) FROM authors WHERE id = 1`,
	} {
		assertCount(t, fixture.db.Reader, query, 1)
	}
	file, err := fixture.store.OpenBook(fileHash, "epub")
	if err != nil {
		t.Fatalf("deleted book's shared blob was removed: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func assertCount(t *testing.T, database *sql.DB, query string, want int) {
	t.Helper()
	var got int
	if err := database.QueryRowContext(context.Background(), query).Scan(&got); err != nil || got != want {
		t.Fatalf("%s = %d, %v; want %d", query, got, err, want)
	}
}

func TestLibraryMoveDoesNotCreateFieldProvenance(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	patch := bookPatch(t, `{"library_id":20}`)
	book, err := fixture.service.UpdateBook(ctx, Viewer{UserID: 1, IsAdmin: true}, 101, patch)
	if err != nil || book.LibraryID != 20 {
		t.Fatalf("move book = %+v, %v", book, err)
	}
	fields := make([]string, 0, len(book.FieldSources))
	for _, source := range book.FieldSources {
		fields = append(fields, source.Field)
	}
	if !reflect.DeepEqual(fields, []string{"title"}) {
		t.Fatalf("field sources after move = %v", fields)
	}
	if _, err := fixture.service.GetBook(ctx, Viewer{UserID: 2}, 101); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reader sees moved book: %v", err)
	}
	if moved, err := fixture.service.GetBook(ctx, Viewer{UserID: 3}, 101); err != nil || moved.LibraryID != 20 {
		t.Fatalf("destination reader cannot see moved book: %+v, %v", moved, err)
	}
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM books WHERE id = 101 AND library_id = 10`, 0)
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM book_files WHERE id = 201 AND book_id = 101`, 1)
}

func TestLibraryMoveRejectsDuplicateAndInvalidTargets(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	if _, err := fixture.db.Writer.Exec(`INSERT INTO books (id,library_id,title,sort_title,created_at,updated_at)
		VALUES (105,20,'Copy','copy',1,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.Exec(`INSERT INTO book_files (book_id,sha256,format,size_bytes,original_filename,created_at)
		SELECT 105,sha256,format,size_bytes,original_filename,created_at FROM book_files WHERE book_id = 101`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		viewer  Viewer
		patch   string
		wantErr error
	}{
		{"duplicate", admin, `{"library_id":20,"title":"Changed"}`, ErrConflict},
		{"missing", admin, `{"library_id":999}`, ErrNotFound},
		{"null", admin, `{"library_id":null}`, ErrInvalid},
		{"reader", Viewer{UserID: 2}, `{"library_id":30}`, ErrForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := fixture.service.UpdateBook(ctx, tc.viewer, 101, bookPatch(t, tc.patch)); !errors.Is(err, tc.wantErr) {
				t.Fatalf("move error=%v, want %v", err, tc.wantErr)
			}
			book, err := fixture.service.GetBook(ctx, admin, 101)
			if err != nil || book.LibraryID != 10 || book.Title != "Tie A" {
				t.Fatalf("rejected move changed source: %+v, %v", book, err)
			}
		})
	}
}
