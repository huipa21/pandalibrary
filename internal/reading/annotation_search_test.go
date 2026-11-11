package reading

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestSearchAnnotationsIncludesReviewsAndInsertedText(t *testing.T) {
	f := newReadingFixture(t)
	ctx := context.Background()
	for _, row := range []struct {
		user, book int
	}{
		{2, 101}, {2, 102}, {2, 103}, {1, 101},
	} {
		if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO book_reviews
			(book_id, user_id, body, created_at, updated_at) VALUES (?, ?, '这是一个扣子的大纲 100% literal', 100, 100)`,
			row.book, row.user); err != nil {
			t.Fatal(err)
		}

	}
	for index, row := range []struct {
		user, book int
		deleted    any
	}{
		{2, 101, nil}, {2, 102, nil}, {2, 103, nil}, {1, 101, nil}, {2, 101, 1},
	} {
		if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO page_annotations
			(id, user_id, book_id, kind, locator, position, data, created_at, updated_at, deleted_at, rev)
			VALUES (?, ?, ?, 'text', '{"type":"pdf","page":5,"rect":{"x":0,"y":0,"width":1,"height":1}}',
				0.5, '{"text":"扣子已经关闭了 100% literal","color":"#000000","size":0.02}', 200, 200, ?, 1)`,
			fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", index+1), row.user, row.book, row.deleted); err != nil {
			t.Fatal(err)
		}
	}
	for _, query := range []string{"扣子", "扣", "100%", "%", "literal"} {
		results, err := f.service.SearchAnnotations(ctx, Viewer{UserID: 2}, query, "")
		if err != nil || len(results) != 2 {
			t.Fatalf("search %q = %+v, %v", query, results, err)
		}
		if results[0].Kind != "text" || results[0].Content != "扣子已经关闭了 100% literal" ||
			results[0].Position != 0.5 || results[1].Kind != "review" {
			t.Fatalf("search kinds/content = %+v", results)
		}
		for _, result := range results {
			if result.BookID != 101 {
				t.Fatalf("search exposed unavailable book: %+v", result)
			}
		}
	}
	for _, query := range []string{"扣子已经", "一个扣子"} {
		results, err := f.service.SearchAnnotations(ctx, Viewer{UserID: 2}, query, "")
		if err != nil || len(results) != 1 {
			t.Fatalf("long CJK search %q = %+v, %v", query, results, err)
		}
	}
	results, err := f.service.SearchAnnotations(ctx, Viewer{UserID: 2}, "_", "")
	if err != nil || len(results) != 0 {
		t.Fatalf("literal underscore = %+v, %v", results, err)
	}
	admin, err := f.service.SearchAnnotations(ctx, Viewer{UserID: 1, IsAdmin: true}, "扣子", "")
	if err != nil || len(admin) != 2 {
		t.Fatalf("admin must search only own content = %+v, %v", admin, err)
	}
}

func TestSearchInsertedTextReturnsNewestHundred(t *testing.T) {
	f := newReadingFixture(t)
	ctx := context.Background()
	for i := 1; i <= 105; i++ {
		if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO page_annotations
			(id, user_id, book_id, kind, locator, position, data, created_at, updated_at, rev)
			VALUES (?, 2, 101, 'text', '{}', 0.5, '{"text":"扣子"}', ?, ?, 1)`,
			fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", i), i, i); err != nil {
			t.Fatal(err)
		}
	}
	results, err := f.service.SearchAnnotations(ctx, Viewer{UserID: 2}, "扣子", "")
	if err != nil || len(results) != 100 || results[0].CreatedAt.UnixMilli() != 105 ||
		results[99].CreatedAt.UnixMilli() != 6 {
		t.Fatalf("capped inserted text search = %+v, %v", results, err)
	}
}

func TestSearchAnnotationPresentationAndDestinations(t *testing.T) {
	f := newReadingFixture(t)
	ctx := context.Background()
	const highlightID = "018f0f7e-7b00-7000-8000-000000000001"
	const noteID = "018f0f7e-7b00-7000-8000-000000000002"
	for _, statement := range []string{
		`UPDATE books SET cover_sha256 = '` + strings.Repeat("b", 64) + `' WHERE id = 101`,
		`INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
			VALUES (202, 101, '` + strings.Repeat("c", 64) + `', 'pdf', 1, 'book.pdf', 1)`,
		`INSERT INTO highlights
			(id, user_id, book_id, book_file_id, locator, position, text, style, created_at, updated_at, rev)
			VALUES ('` + highlightID + `', 2, 101, 201, '{"type":"cfi","value":"epubcfi(/6/2)"}',
				0.2, 'shared passage', 'underline', 100, 100, 1)`,
		`INSERT INTO notes (id, user_id, book_id, highlight_id, body_md, created_at, updated_at, rev)
			VALUES ('` + noteID + `', 2, 101, '` + highlightID + `', 'shared comment', 200, 200, 1)`,
		`INSERT INTO page_annotations
			(id, user_id, book_id, book_file_id, kind, locator, position, data, created_at, updated_at, rev)
			VALUES ('018f0f7e-7b00-7000-8000-000000000003', 2, 101, 202, 'text',
				'{"type":"pdf","page":5,"rect":{"x":0,"y":0,"width":1,"height":1}}',
				0.8, '{"text":"shared insert"}', 300, 300, 1)`,
		`INSERT INTO highlights_fts (rowid, text, user_id, book_id)
			SELECT seq, text, user_id, book_id FROM highlights`,
		`INSERT INTO notes_fts (rowid, body, highlight_text, user_id, book_id)
			SELECT seq, body_md, '', user_id, book_id FROM notes`,
	} {
		if _, err := f.db.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	for _, query := range []string{"shared", "sh"} {
		results, err := f.service.SearchAnnotations(ctx, Viewer{UserID: 2}, query, "")
		if err != nil || len(results) != 3 {
			t.Fatalf("search = %+v, %v", results, err)
		}
		for _, result := range results {
			fileID := int64(201)
			if result.Kind == "text" {
				fileID = 202
			}
			if result.BookTitle != "Visible" || result.CoverURL == nil || *result.CoverURL != "/api/v1/books/101/cover" ||
				result.BookFileID == nil || *result.BookFileID != fileID {
				t.Fatalf("missing book metadata: %+v", result)
			}
		}
		if results[0].Kind != "text" || !strings.Contains(string(results[0].Locator), `"page":5`) ||
			results[1].Kind != "note" || results[1].HighlightID == nil || *results[1].HighlightID != highlightID ||
			results[1].Anchor != "shared passage" || results[2].Kind != "underline" ||
			results[2].HighlightID == nil || *results[2].HighlightID != highlightID {
			t.Fatalf("missing annotation targets: %+v", results)
		}
		for _, kind := range []string{"comment", "underline", "text", "review", "book_note", "highlight", "strikeout", "ink", "image"} {
			filtered, err := f.service.SearchAnnotations(ctx, Viewer{UserID: 2}, query, kind)
			if err != nil {
				t.Fatal(err)
			}
			want := 0
			if kind == "comment" || kind == "underline" || kind == "text" {
				want = 1
			}
			if len(filtered) != want || (want == 1 && filtered[0].ID != map[string]string{
				"comment": noteID, "underline": highlightID, "text": "018f0f7e-7b00-7000-8000-000000000003",
			}[kind]) {
				t.Fatalf("search %q kind %q = %+v", query, kind, filtered)
			}
		}
	}
	if _, err := f.service.SearchAnnotations(ctx, Viewer{UserID: 2}, "shared", "invalid"); err == nil {
		t.Fatal("expected invalid kind to be rejected")
	}
}

func TestSearchAnnotationKindBeforeResultCap(t *testing.T) {
	f := newReadingFixture(t)
	ctx := context.Background()
	for i := 1; i <= 105; i++ {
		style := "highlight"
		if i == 105 {
			style = "underline"
		}
		if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO highlights
			(id, user_id, book_id, book_file_id, locator, position, text, style, created_at, updated_at, rev)
			VALUES (?, 2, 101, 201, '{}', ?, 'shared passage', ?, ?, ?, 1)`,
			fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", i), float64(i)/106, style, i, i); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO highlights_fts (rowid, text, user_id, book_id)
		SELECT seq, text, user_id, book_id FROM highlights`); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"shared", "sh"} {
		results, err := f.service.SearchAnnotations(ctx, Viewer{UserID: 2}, query, "underline")
		if err != nil || len(results) != 1 || results[0].Kind != "underline" {
			t.Fatalf("filter before cap %q = %+v, %v", query, results, err)
		}
	}
}
