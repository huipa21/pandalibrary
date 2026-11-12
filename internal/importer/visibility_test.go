package importer

import (
	"bytes"
	"context"
	"testing"

	"pandalibrary/internal/catalog"
)

func TestPrivateDuplicatePreservesSharingAndRedactsHistory(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.db.Writer.Exec(`INSERT INTO users (id,username,password_hash,role,created_at,updated_at)
		VALUES (2,'another-admin','x','admin',1,1)`); err != nil {
		t.Fatal(err)
	}
	data := []byte(`<FictionBook><description><title-info><book-title>Private Original</book-title></title-info></description></FictionBook>`)
	queue := func(viewer catalog.Viewer, visibility string) Job {
		t.Helper()
		staged, err := f.service.Stage(ctx, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		job, err := f.service.QueueUpload(ctx, viewer, 1, 0, "original.fb2", staged, visibility)
		if err != nil {
			t.Fatal(err)
		}
		return job
	}
	first := queue(admin, "private")
	if err := f.service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	original := f.wait(t, first.ID)
	if original.Status != "imported" {
		t.Fatalf("original=%+v", original)
	}
	other := catalog.Viewer{UserID: 2, IsAdmin: true}
	second := queue(other, "public")
	duplicate := f.wait(t, second.ID)
	if duplicate.Status != "duplicate" {
		t.Fatalf("duplicate=%+v", duplicate)
	}
	history, err := f.service.History(ctx, other, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range history.Items {
		if job.BookID != nil || job.DuplicateOfBookID != nil {
			t.Fatalf("private ID leaked: %+v", job)
		}
	}
	var owner int64
	var visibility string
	if err := f.db.Reader.QueryRow(`SELECT owner_id,visibility FROM books WHERE id=?`, original.BookID).Scan(&owner, &visibility); err != nil || owner != 1 || visibility != "private" {
		t.Fatalf("duplicate changed original: owner=%d visibility=%s err=%v", owner, visibility, err)
	}
}
