package catalog

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestListPersonalActivityNewestFirstAndPaginated(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	const highlightID = "00000000-0000-7000-8000-000000000001"
	if _, err := fixture.db.Writer.ExecContext(ctx, `UPDATE books SET cover_sha256 = ? WHERE id = 101`, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO highlights
		(id, user_id, book_id, book_file_id, locator, position, text, created_at, updated_at, rev)
		VALUES (?, 2, 101, 201, '{}', 0.2, 'Passage text', 150, 150, 1)`, highlightID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO notes
		(id, user_id, book_id, highlight_id, body_md, created_at, updated_at, rev)
		VALUES ('00000000-0000-7000-8000-000000000002', 2, 101, ?, 'A passage comment', 300, 300, 1)`, highlightID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO notes
		(id, user_id, book_id, body_md, created_at, updated_at, rev)
		VALUES ('00000000-0000-7000-8000-000000000003', 2, 101, 'A private book note', 200, 200, 1),
		('00000000-0000-7000-8000-000000000004', 2, 101, 'Deleted note', 500, 500, 1),
		('00000000-0000-7000-8000-000000000005', 2, 103, 'Inaccessible note', 600, 600, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `UPDATE notes SET deleted_at = 1 WHERE id = '00000000-0000-7000-8000-000000000004'`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO book_reviews (id, book_id, user_id, body, created_at, updated_at)
		VALUES (7, 101, 2, 'A public review', 400, 400)`); err != nil {
		t.Fatal(err)
	}
	viewer := Viewer{UserID: 2}
	var got []PersonalActivity
	cursor := ""
	for pageNumber := 0; ; pageNumber++ {
		if pageNumber > 5 {
			t.Fatal("pagination did not terminate")
		}
		page, err := fixture.service.ListPersonalActivity(ctx, viewer, PersonalActivityOptions{Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != 4 {
			t.Fatalf("total = %d, want 4 across all pages", page.Total)
		}
		got = append(got, page.Items...)
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if kinds := []string{got[0].Kind, got[1].Kind, got[2].Kind, got[3].Kind}; !reflect.DeepEqual(kinds, []string{"review", "comment", "book_note", "highlight"}) {
		t.Fatalf("kinds newest first = %v", kinds)
	}
	if got[1].Anchor != "Passage text" || got[0].Content != "A public review" || got[2].Content != "A private book note" {
		t.Fatalf("activities = %+v", got)
	}
	if got[1].HighlightID == nil || *got[1].HighlightID != highlightID ||
		got[3].HighlightID == nil || *got[3].HighlightID != highlightID || got[2].HighlightID != nil {
		t.Fatalf("activity passage targets = %+v", got)
	}
	if got[1].BookFileID == nil || *got[1].BookFileID != 201 ||
		got[3].BookFileID == nil || *got[3].BookFileID != 201 {
		t.Fatalf("activity file targets = %+v", got)
	}
	if got[0].CoverURL == nil || *got[0].CoverURL != "/api/v1/books/101/cover" {
		t.Fatalf("cover URL = %v", got[0].CoverURL)
	}
	if len(got) != 4 {
		t.Fatalf("got %d activities, want 4", len(got))
	}
	for _, kind := range []string{"review", "comment", "book_note", "highlight", "underline", "strikeout", "text", "ink", "image"} {
		page, err := fixture.service.ListPersonalActivity(ctx, viewer, PersonalActivityOptions{Limit: 1, Kind: kind})
		if err != nil {
			t.Fatal(err)
		}
		want := int64(0)
		if kind == "review" || kind == "comment" || kind == "book_note" || kind == "highlight" {
			want = 1
		}
		if page.Total != want || int64(len(page.Items)) != want || page.NextCursor != nil {
			t.Fatalf("filtered %s = %+v, want total %d", kind, page, want)
		}
		if want > 0 && page.Items[0].Kind != kind {
			t.Fatalf("filter %s returned %s", kind, page.Items[0].Kind)
		}
	}
	first, err := fixture.service.ListPersonalActivity(ctx, viewer, PersonalActivityOptions{Limit: 1})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("expected activity cursor: %+v, %v", first, err)
	}
	if _, err := fixture.service.ListPersonalActivity(ctx, viewer, PersonalActivityOptions{Limit: 1, Kind: "comment", Cursor: *first.NextCursor}); err == nil {
		t.Fatal("cursor from All must not be accepted by a type filter")
	}
}

func TestPersonalActivityIncludesInsertedTextAndDrawingsWithVisibilityAndTies(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	for index, row := range []struct {
		user, book int
		kind, data string
		deleted    any
	}{
		{2, 101, "text", `{"text":"扣子已经关闭了","color":"#000000","size":0.02}`, nil},
		{2, 101, "ink", `{"color":"#000000","width":0.01,"strokes":[[0.1,0.2,0.3,0.4]]}`, nil},
		{2, 102, "text", `{"text":"hidden"}`, nil},
		{2, 103, "text", `{"text":"inaccessible"}`, nil},
		{1, 101, "text", `{"text":"someone else's"}`, nil},
		{2, 101, "text", `{"text":"deleted"}`, 1},
	} {
		_, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO page_annotations
			(id, user_id, book_id, kind, locator, position, data, created_at, updated_at, deleted_at, rev)
			VALUES (?, ?, ?, ?, '{"type":"pdf","page":5,"rect":{"x":0.1,"y":0.2,"width":0.3,"height":0.4}}',
				0.5, ?, 500, 500, ?, 1)`, fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", index+1),
			row.user, row.book, row.kind, row.data, row.deleted)
		if err != nil {
			t.Fatal(err)
		}
	}
	first, err := fixture.service.ListPersonalActivity(ctx, Viewer{UserID: 2}, PersonalActivityOptions{Limit: 1})
	if err != nil || len(first.Items) != 1 || first.Items[0].Kind != "text" || first.NextCursor == nil {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	if first.Items[0].Content != "扣子已经关闭了" || !strings.Contains(string(first.Items[0].Locator), `"page":5`) {
		t.Fatalf("inserted text = %+v", first.Items[0])
	}
	second, err := fixture.service.ListPersonalActivity(ctx, Viewer{UserID: 2}, PersonalActivityOptions{Limit: 1, Cursor: *first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].Kind != "ink" || second.NextCursor != nil ||
		!strings.Contains(string(second.Items[0].Data), `"strokes"`) {
		t.Fatalf("drawing page = %+v, %v", second, err)
	}
	// Admin access still never includes other users' annotations.
	admin, err := fixture.service.ListPersonalActivity(ctx, Viewer{UserID: 1, IsAdmin: true}, PersonalActivityOptions{})
	if err != nil || len(admin.Items) != 1 || admin.Items[0].Content != "someone else's" {
		t.Fatalf("admin activity = %+v, %v", admin, err)
	}
}

func TestListPersonalActivityRejectsInvalidViewerAndCursor(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	for _, test := range []struct {
		name   string
		viewer Viewer
		page   PersonalActivityOptions
	}{
		{name: "viewer", page: PersonalActivityOptions{}},
		{name: "kind", viewer: Viewer{UserID: 2}, page: PersonalActivityOptions{Kind: "invalid"}},
		{name: "cursor", viewer: Viewer{UserID: 2}, page: PersonalActivityOptions{Cursor: "eyJ2IjoxLCJrIjoicGVyc29uYWxfYWN0aXZpdHkiLCJzIjoiMjpmYWxzZSIsIm8iOiJjcmVhdGVkIiwiaSI6MSwidCI6ImJhZDogMSIsImQiOjF9"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := fixture.service.ListPersonalActivity(ctx, test.viewer, test.page); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}
