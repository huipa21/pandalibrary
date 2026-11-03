package export

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

type exportFixture struct {
	service *Service
	db      *db.DB
}

func newExportFixture(t *testing.T) exportFixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "export.db")
	databases, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close databases: %v", err)
		}
	})
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), migrations.Options{AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(databases.Writer, databases.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return time.Date(2026, time.November, 3, 10, 0, 0, 0, time.UTC) }
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1), (2, 'reader', 'x', 'user', 1, 1), (3, 'other', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1), (20, 3, 1)`,
		`INSERT INTO authors (id, name, sort_name, created_at) VALUES
			(1, 'First Author', 'First Author', 1), (2, 'Second: "Author"', 'Second', 1),
			(3, 'Writer', 'Writer', 1)`,
		`INSERT INTO series (id, name, created_at) VALUES (1, 'Saga: "One"', 1)`,
		`INSERT INTO tags (id, name, created_at) VALUES (1, 'tag: [one]', 1), (2, 'second', 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, series_id, series_index, created_at, updated_at) VALUES
			(101, 10, '三体: "The"' || char(10) || '---', 'three-body', 1, 1.5, 1, 1),
			(102, 10, 'Empty', 'empty', NULL, NULL, 1, 1),
			(103, 20, 'Secret', 'secret', NULL, NULL, 1, 1),
			(104, 10, 'Same', 'same', NULL, NULL, 1, 1),
			(105, 10, 'same', 'same', NULL, NULL, 1, 1)`,
		`INSERT INTO book_authors (book_id, author_id, role, position) VALUES
			(101, 1, 'author', 0), (101, 2, 'author', 1),
			(104, 3, 'author', 0), (105, 3, 'author', 0)`,
		`INSERT INTO book_tags (book_id, tag_id) VALUES (101, 1), (101, 2)`,
		`INSERT INTO book_identifiers (book_id, scheme, value) VALUES
			(101, 'isbn10', 'old-isbn'), (101, 'isbn13', '9780000000001')`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 102, 1, 1)`,
		`INSERT INTO highlights (id, user_id, book_id, locator, position, text, created_at, updated_at, deleted_at, rev) VALUES
			('0190f5c2-7a00-7000-8000-000000000002', 2, 101, '{}', 0.5, 'Later' || char(10) || 'quoted', 10, 10, NULL, 1),
			('0190f5c2-7a00-7000-8000-000000000001', 2, 101, '{}', 0.1, 'First highlight', 10, 10, NULL, 2),
			('0190f5c2-7a00-7000-8000-000000000003', 2, 101, '{}', 0.2, 'Deleted highlight', 10, 10, 99, 3),
			('0190f5c2-7a00-7000-8000-000000000004', 3, 101, '{}', 0.3, 'Another user highlight', 10, 10, NULL, 4),
			('0190f5c2-7a00-7000-8000-000000000005', 3, 103, '{}', 0.1, 'Secret highlight', 10, 10, NULL, 5)`,
		`INSERT INTO notes (id, user_id, book_id, highlight_id, body_md, created_at, updated_at, deleted_at, rev) VALUES
			('0190f5c2-7a00-7000-8000-000000000011', 2, 101, NULL, 'Old note', 10, 10, NULL, 1),
			('0190f5c2-7a00-7000-8000-000000000012', 2, 101, NULL, 'New **note**', 20, 30, NULL, 2),
			('0190f5c2-7a00-7000-8000-000000000013', 2, 101, '0190f5c2-7a00-7000-8000-000000000001', '*Attached note*', 15, 15, NULL, 3),
			('0190f5c2-7a00-7000-8000-000000000014', 2, 101, '0190f5c2-7a00-7000-8000-000000000003', 'Orphaned note', 16, 16, NULL, 4),
			('0190f5c2-7a00-7000-8000-000000000015', 2, 101, NULL, 'Deleted note', 40, 40, 41, 5),
			('0190f5c2-7a00-7000-8000-000000000016', 3, 101, NULL, 'Another user note', 50, 50, NULL, 6),
			('0190f5c2-7a00-7000-8000-000000000017', 3, 103, NULL, 'Secret note', 50, 50, NULL, 7)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed export fixture: %v", err)
		}
	}
	return exportFixture{service: service, db: databases}
}

func TestExportMarkdownGoldenAndAnnotationBoundaries(t *testing.T) {
	fixture := newExportFixture(t)
	result, err := fixture.service.Export(context.Background(), Viewer{UserID: 2}, []int64{101})
	if err != nil {
		t.Fatal(err)
	}
	if result.ContentType != "text/markdown; charset=utf-8" ||
		result.Filename != `三体_ _The_ --- - First Author.md` {
		t.Fatalf("single-book response metadata = %q %q", result.ContentType, result.Filename)
	}
	const want = `---
title: "三体: \"The\"\n---"
author:
  - "First Author"
  - "Second: \"Author\""
series: "Saga: \"One\""
series_index: 1.5
isbn: "9780000000001"
tags:
  - "second"
  - "tag: [one]"
pandalibrary_id: 101
exported: 2026-11-03
---
# 三体: "The" ---

## Notes

New **note**

Old note

## Highlights

> First highlight ^hl-0190f5c2-7a00-7000-8000-000000000001

*Attached note*

> Later
> quoted ^hl-0190f5c2-7a00-7000-8000-000000000002

`
	if string(result.Body) != want {
		t.Fatalf("Markdown document mismatch\n--- got ---\n%s\n--- want ---\n%s", result.Body, want)
	}
	for _, forbidden := range []string{"Deleted highlight", "Orphaned note", "Deleted note", "Another user", "Secret"} {
		if strings.Contains(string(result.Body), forbidden) {
			t.Errorf("export leaked %q: %s", forbidden, result.Body)
		}
	}
}

func TestExportEmptySectionsAndSafeUniqueZIPEntries(t *testing.T) {
	fixture := newExportFixture(t)
	// Book 102 is hidden from the reader but remains visible to the admin.
	result, err := fixture.service.Export(context.Background(), Viewer{UserID: 1, IsAdmin: true}, []int64{102, 104, 105})
	if err != nil {
		t.Fatal(err)
	}
	if result.ContentType != "application/zip" || result.Filename != "PandaLibrary notes 2026-11-03.zip" {
		t.Fatalf("archive response metadata = %q %q", result.ContentType, result.Filename)
	}
	reader, err := zip.NewReader(bytes.NewReader(result.Body), int64(len(result.Body)))
	if err != nil {
		t.Fatal(err)
	}
	if len(reader.File) != 3 {
		t.Fatalf("archive has %d members, want 3", len(reader.File))
	}
	seen := map[string]bool{}
	for _, member := range reader.File {
		if seen[filenameCollisionKey(member.Name)] {
			t.Errorf("duplicate normalized ZIP member %q", member.Name)
		}
		seen[filenameCollisionKey(member.Name)] = true
		if strings.ContainsAny(member.Name, `/\:*?"<>|`) || strings.HasPrefix(member.Name, "/") {
			t.Errorf("unsafe ZIP member name %q", member.Name)
		}
		file, err := member.Open()
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(file)
		_ = file.Close()
		if err != nil {
			t.Fatal(err)
		}
		if member.Name == "Empty - Unknown Author.md" &&
			(!bytes.Contains(body, []byte("## Notes\n\n## Highlights")) ||
				bytes.Contains(body, []byte("Old note"))) {
			t.Errorf("empty book document has incorrect sections: %s", body)
		}
	}
	if !seen[filenameCollisionKey("Same - Writer.md")] ||
		!seen[filenameCollisionKey("same - Writer (2).md")] {
		t.Fatalf("archive member names = %v", seen)
	}
	if safeMarkdownFilename("CON") != "_CON.md" {
		t.Fatalf("reserved device name was not escaped: %q", safeMarkdownFilename("CON"))
	}
}

func TestExportRejectsInvisibleBooksAndInvalidSelections(t *testing.T) {
	fixture := newExportFixture(t)
	for _, bookIDs := range [][]int64{{102}, {103}, {999}, {101, 103}} {
		_, err := fixture.service.Export(context.Background(), Viewer{UserID: 2}, bookIDs)
		if err != ErrNotFound {
			t.Errorf("export %v error = %v, want not found", bookIDs, err)
		}
	}
	for _, bookIDs := range [][]int64{nil, {}, {0}, {101, 101}} {
		_, err := fixture.service.Export(context.Background(), Viewer{UserID: 2}, bookIDs)
		if err == nil || !strings.Contains(err.Error(), ErrInvalid.Error()) {
			t.Errorf("export %v error = %v, want invalid request", bookIDs, err)
		}
	}
}

func TestExportUsesReadOnlyDatabaseAccess(t *testing.T) {
	fixture := newExportFixture(t)
	_, err := fixture.db.Reader.ExecContext(context.Background(), `DELETE FROM notes`)
	if err == nil {
		t.Fatal("reader pool allowed a write")
	}
	if _, err := fixture.service.Export(context.Background(), Viewer{UserID: 2}, []int64{101}); err != nil {
		t.Fatal(err)
	}
}
