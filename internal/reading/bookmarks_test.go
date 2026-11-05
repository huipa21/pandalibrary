package reading

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestBookmarksSyncValidationAndTombstones(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
		VALUES (202, 101, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'pdf', 1, 'book.pdf', 1)
	`); err != nil {
		t.Fatal(err)
	}
	id := "018f0f7e-7b00-7000-8000-000000000001"
	cfi := `{"book_id":101,"book_file_id":201,"locator":{"type":"cfi","value":"epubcfi(/6/2)"},"position":0.4,"label":"start"}`
	pdf := `{"book_id":101,"book_file_id":202,"locator":{"type":"pdf","page":3},"position":0.6,"label":"page"}`
	push := func(user Viewer, items ...Mutation) []MutationResult {
		t.Helper()
		result, err := fixture.service.Push(ctx, user, PushRequest{Mutations: items})
		if err != nil {
			t.Fatal(err)
		}
		return result.Results
	}
	if result := push(viewer, mutation("bookmarks", id, "", "upsert", cfi, 1000)); result[0].Status != "applied" {
		t.Fatalf("create = %+v", result)
	}
	if result := push(viewer, mutation("bookmarks", id, "", "upsert", cfi, 1000)); result[0].Status != "stale" {
		t.Fatalf("duplicate = %+v", result)
	}
	if result := push(viewer, mutation("bookmarks", id, "", "upsert", pdf, 1100)); result[0].Status != "applied" {
		t.Fatalf("edit = %+v", result)
	}
	state, err := fixture.service.GetBookState(ctx, viewer, 101)
	if err != nil || len(state.Bookmarks) != 1 || state.Bookmarks[0].Label != "page" ||
		state.Bookmarks[0].BookFileID == nil || *state.Bookmarks[0].BookFileID != 202 {
		t.Fatalf("book state = %+v, %v", state, err)
	}
	before, err := fixture.service.Pull(ctx, viewer, 0)
	if err != nil || len(before.Bookmarks) != 1 || before.Bookmarks[0].Rev == 0 {
		t.Fatalf("pull = %+v, %v", before, err)
	}
	if result := push(Viewer{UserID: 1, IsAdmin: true}, mutation("bookmarks", id, "", "upsert", cfi, 1200)); result[0].Status != "rejected" {
		t.Fatalf("other owner = %+v", result)
	}
	if result := push(viewer, mutation("bookmarks", id, "", "delete", `{}`, 1200)); result[0].Status != "applied" {
		t.Fatalf("delete = %+v", result)
	}
	if result := push(viewer, mutation("bookmarks", id, "", "delete", `{}`, 1300)); result[0].Status != "stale" {
		t.Fatalf("duplicate delete = %+v", result)
	}
	if result := push(viewer, mutation("bookmarks", id, "", "upsert", cfi, 1100)); result[0].Status != "stale" {
		t.Fatalf("old edit after delete = %+v", result)
	}
	after, err := fixture.service.Pull(ctx, viewer, before.Cursor)
	if err != nil || len(after.Bookmarks) != 1 || after.Bookmarks[0].DeletedAt == nil ||
		after.Bookmarks[0].Rev <= before.Bookmarks[0].Rev {
		t.Fatalf("tombstone pull = %+v, %v", after, err)
	}
	if result := push(viewer, mutation("bookmarks", id, "", "upsert", cfi, 1400)); result[0].Status != "applied" {
		t.Fatalf("newer edit = %+v", result)
	}

	invalid := []string{
		`{"book_id":101,"locator":{"type":"pdf","page":1},"position":0.2}`,
		`{"book_id":101,"book_file_id":999,"locator":{"type":"pdf","page":1},"position":0.2}`,
		`{"book_id":102,"book_file_id":201,"locator":{"type":"cfi","value":"epubcfi(/6/2)"},"position":0.2}`,
		`{"book_id":101,"book_file_id":201,"locator":null,"position":0.2}`,
		`{"book_id":101,"book_file_id":201,"locator":{"type":"pdf","page":1},"position":0.2}`,
		`{"book_id":101,"book_file_id":202,"locator":{"type":"pdf","page":0},"position":0.2}`,
		`{"book_id":101,"book_file_id":202,"locator":{"type":"pdf","page":1,"rects":[{"x":0.9,"y":0,"width":0.5,"height":0.1}]},"position":0.2}`,
		`{"book_id":101,"book_file_id":201,"locator":{"type":"cfi","value":"not a CFI"},"position":0.2}`,
		`{"book_id":101,"book_file_id":201,"locator":{"type":"cfi","value":"epubcfi(/6/2)"},"position":2}`,
		`{"book_id":101,"book_file_id":201,"locator":{"type":"cfi","value":"epubcfi(/6/2)"},"label":"` + strings.Repeat("x", 513) + `"}`,
	}
	for i, data := range invalid {
		invalidID := fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", i+2)
		if result := push(viewer, mutation("bookmarks", invalidID, "", "upsert", data, 1500)); result[0].Status != "rejected" {
			t.Errorf("invalid case %d = %+v", i, result)
		}
	}
}

func TestBookmarkPagesAreScopedStableAndVisibilityFiltered(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		VALUES (104, 10, 'Another', 'another', 1, 1);
		INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
		VALUES (204, 104, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'pdf', 1, 'other.pdf', 1)
	`); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		id := fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", i)
		data := `{"book_id":101,"book_file_id":201,"locator":{"type":"cfi","value":"epubcfi(/6/2)"},"position":0.4,"created_at":1000}`
		result, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
			mutation("bookmarks", id, "", "upsert", data, int64(1000+i)),
		}})
		if err != nil || result.Results[0].Status != "applied" {
			t.Fatalf("seed bookmark %d: %+v, %v", i, result, err)
		}
	}
	first, err := fixture.service.ListUserBookmarks(ctx, viewer, BookmarkPageOptions{Limit: 1})
	if err != nil || len(first.Items) != 1 || first.Items[0].ID != "018f0f7e-7b00-7000-8000-000000000003" ||
		first.Items[0].Book.Title != "Visible" || first.NextCursor == nil {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	// A newly inserted earlier row must not shift the next page.
	newer := mutation("bookmarks", "018f0f7e-7b00-7000-8000-000000000004", "", "upsert",
		`{"book_id":104,"book_file_id":204,"locator":{"type":"pdf","page":1},"position":0.1,"created_at":1500}`, 1500)
	if result, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{newer}}); err != nil || result.Results[0].Status != "applied" {
		t.Fatalf("insert between pages = %+v, %v", result, err)
	}
	second, err := fixture.service.ListUserBookmarks(ctx, viewer, BookmarkPageOptions{Limit: 1, Cursor: *first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].ID != "018f0f7e-7b00-7000-8000-000000000002" {
		t.Fatalf("second page = %+v, %v", second, err)
	}
	for _, test := range []struct {
		viewer Viewer
		bookID int64
	}{
		{Viewer{UserID: 3}, 0},
		{Viewer{UserID: 2, IsAdmin: true}, 0},
		{viewer, 101},
	} {
		_, err := fixture.service.ListUserBookmarks(ctx, test.viewer, BookmarkPageOptions{Cursor: *first.NextCursor, BookID: test.bookID})
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("cursor scope %+v = %v", test, err)
		}
	}
	filtered, err := fixture.service.ListUserBookmarks(ctx, viewer, BookmarkPageOptions{BookID: 104})
	if err != nil || len(filtered.Items) != 1 || filtered.Items[0].Book.Title != "Another" {
		t.Fatalf("filtered page = %+v, %v", filtered, err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 101, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	visible, err := fixture.service.ListUserBookmarks(ctx, viewer, BookmarkPageOptions{})
	if err != nil || len(visible.Items) != 1 || visible.Items[0].BookID != 104 {
		t.Fatalf("hidden book leaked = %+v, %v", visible, err)
	}
	other, err := fixture.service.ListUserBookmarks(ctx, Viewer{UserID: 3}, BookmarkPageOptions{})
	if err != nil || len(other.Items) != 0 {
		t.Fatalf("other user's bookmarks leaked = %+v, %v", other, err)
	}
}
