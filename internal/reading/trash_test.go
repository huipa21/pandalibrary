package reading

import (
	"context"
	"testing"
	"time"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/trash"
)

func TestTrashHighlightRestoresCascadeAndPurgeRejectsSync(t *testing.T) {
	f := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	h := "018f0f7e-7b00-7000-8000-000000000001"
	n := "018f0f7e-7b00-7000-8000-000000000002"
	push := func(mutations ...Mutation) {
		t.Helper()
		result, err := f.service.Push(ctx, viewer, PushRequest{Mutations: mutations})
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range result.Results {
			if r.Status != "applied" {
				t.Fatalf("mutation = %+v", r)
			}
		}
	}
	push(
		mutation("highlights", h, "", "upsert", `{"book_id":101,"locator":{"cfi":"b"},"position":0.4,"text":"alpha highlight","color":"yellow"}`, 1400),
		mutation("notes", n, "", "upsert", `{"book_id":101,"highlight_id":"`+h+`","body_md":"alpha note"}`, 1500),
	)
	push(mutation("highlights", h, "", "delete", `{}`, 1600))
	s := trash.NewService(f.db.Writer)
	v := catalog.Viewer{UserID: 2}
	items, err := s.List(ctx, v, "annotation", "")
	if err != nil || len(items) != 1 {
		t.Fatalf("cascade trash = %+v, %v", items, err)
	}
	ref := trash.Ref{Type: "annotation", ID: "highlight:" + h}
	if err := s.Apply(ctx, v, []trash.Ref{ref}, true); err != nil {
		t.Fatal(err)
	}
	state, err := f.service.GetBookState(ctx, viewer, 101)
	if err != nil || len(state.Highlights) != 1 || len(state.Notes) != 1 {
		t.Fatalf("restored state = %+v, %v", state, err)
	}
	search, err := f.service.SearchAnnotations(ctx, viewer, "alpha", "")
	if err != nil || len(search) != 2 {
		t.Fatalf("restored search = %+v, %v", search, err)
	}
	f.service.now = func() time.Time { return time.Now().Add(time.Second) }
	now := time.Now().UnixMilli() + 500
	push(mutation("highlights", h, "", "delete", `{}`, now))
	if err := s.Apply(ctx, v, []trash.Ref{ref}, false); err != nil {
		t.Fatal(err)
	}
	var body string
	var purged int
	if err := f.db.Reader.QueryRowContext(ctx, `SELECT body_md,purged FROM notes WHERE id=?`, n).Scan(&body, &purged); err != nil || body != "" || purged != 1 {
		t.Fatalf("cascaded note purge = %q, %d, %v", body, purged, err)
	}
	result, err := f.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("highlights", h, "", "upsert", `{"book_id":101,"locator":{"cfi":"b"},"position":0.4,"text":"resurrect","color":"yellow"}`, now+1),
	}})
	if err != nil || len(result.Results) != 1 || result.Results[0].Status != "rejected" {
		t.Fatalf("purged sync replay = %+v, %v", result, err)
	}
}

func TestPurgingHighlightScrubsPreviouslyDeletedNotes(t *testing.T) {
	f := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	highlight := "018f0f7e-7b00-7000-8000-000000000011"
	note := "018f0f7e-7b00-7000-8000-000000000012"
	unrelated := "018f0f7e-7b00-7000-8000-000000000013"
	otherHighlight := "018f0f7e-7b00-7000-8000-000000000014"
	push := func(mutations ...Mutation) {
		t.Helper()
		result, err := f.service.Push(ctx, viewer, PushRequest{Mutations: mutations})
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range result.Results {
			if r.Status != "applied" {
				t.Fatalf("mutation = %+v", r)
			}
		}
	}
	noteData := `{"book_id":101,"highlight_id":"` + highlight + `","body_md":"private deleted note"}`
	push(
		mutation("highlights", highlight, "", "upsert", `{"book_id":101,"locator":{"cfi":"b"},"position":0.4,"text":"highlight","color":"yellow"}`, 1000),
		mutation("highlights", otherHighlight, "", "upsert", `{"book_id":101,"locator":{"cfi":"c"},"position":0.5,"text":"other","color":"yellow"}`, 1000),
		mutation("notes", note, "", "upsert", noteData, 1100),
		mutation("notes", unrelated, "", "upsert", `{"book_id":101,"highlight_id":"`+otherHighlight+`","body_md":"unrelated note"}`, 1100),
	)
	push(mutation("notes", note, "", "delete", `{}`, 1200))
	push(mutation("notes", unrelated, "", "delete", `{}`, 1200))
	push(mutation("highlights", highlight, "", "delete", `{}`, 1300))

	s := trash.NewService(f.db.Writer)
	v := catalog.Viewer{UserID: 2}
	if err := s.Apply(ctx, v, []trash.Ref{{Type: "annotation", ID: "highlight:" + highlight}}, false); err != nil {
		t.Fatal(err)
	}
	var body string
	var purged int
	if err := f.db.Reader.QueryRowContext(ctx, `SELECT body_md,purged FROM notes WHERE id=?`, note).Scan(&body, &purged); err != nil || body != "" || purged != 1 {
		t.Fatalf("previously deleted note = %q, purged=%d, %v", body, purged, err)
	}
	if err := f.db.Reader.QueryRowContext(ctx, `SELECT body_md,purged FROM notes WHERE id=?`, unrelated).Scan(&body, &purged); err != nil || body != "unrelated note" || purged != 0 {
		t.Fatalf("unrelated note = %q, purged=%d, %v", body, purged, err)
	}
	items, err := s.List(ctx, v, "annotation", "")
	if err != nil || len(items) != 1 || items[0].ID != "note:"+unrelated {
		t.Fatalf("remaining trash = %+v, %v", items, err)
	}
	result, err := f.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("notes", note, "", "upsert", noteData, 1400),
	}})
	if err != nil || len(result.Results) != 1 || result.Results[0].Status != "rejected" {
		t.Fatalf("purged note sync replay = %+v, %v", result, err)
	}
}
