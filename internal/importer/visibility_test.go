package importer

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"pandalibrary/internal/catalog"
)

func TestIdenticalPrivateBookInOtherLibraryDoesNotClaimUpload(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	if _, err := f.db.Writer.Exec(`INSERT INTO users (id,username,password_hash,role,created_at,updated_at)
		VALUES (2,'another-admin','x','admin',1,1)`); err != nil {
		t.Fatal(err)
	}
	data := []byte(`<FictionBook><description><title-info><book-title>Separate owners</book-title></title-info></description></FictionBook>`)
	if err := f.service.Start(ctx); err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for _, owner := range []int64{1, 2} {
		staged, err := f.service.Stage(ctx, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		job, err := f.service.QueueUpload(ctx, catalog.Viewer{UserID: owner, IsAdmin: true}, owner, 0, "private.fb2", staged, "private")
		if err != nil {
			t.Fatal(err)
		}
		row := f.wait(t, job.ID)
		if row.Status != "imported" {
			t.Fatalf("library %d import: %+v", owner, row)
		}
		ids = append(ids, row.BookID.Int64)
		var gotOwner int64
		if err := f.db.Reader.QueryRow(`SELECT owner_id FROM books WHERE id = ?`, row.BookID).Scan(&gotOwner); err != nil || gotOwner != owner {
			t.Fatalf("owner=%d, want %d: %v", gotOwner, owner, err)
		}
	}
	if _, err := f.service.options.Catalog.GetBook(ctx, admin, ids[1]); !errors.Is(err, catalog.ErrNotFound) {
		t.Fatalf("other library's private upload exposed: %v", err)
	}
}

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
