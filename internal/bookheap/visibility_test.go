package bookheap

import (
	"bytes"
	"context"
	"testing"

	"pandalibrary/internal/catalog"
)

func TestAssignmentPreservesUploaderVisibility(t *testing.T) {
	f := newAssignFixture(t)
	ctx := context.Background()
	if _, err := f.db.Writer.Exec(`UPDATE users SET role='admin' WHERE id=2`); err != nil {
		t.Fatal(err)
	}
	for _, visibility := range []string{"public", "private"} {
		pending, err := f.service.Receive(ctx, admin, visibility+".epub", bytes.NewReader(testEPUB(t, visibility)))
		if err != nil {
			t.Fatal(err)
		}
		if err := pending.SetVisibility(visibility); err != nil {
			t.Fatal(err)
		}
		item, err := f.service.Commit(ctx, admin, pending)
		if err != nil {
			t.Fatal(err)
		}
		result, err := f.service.Assign(ctx, catalog.Viewer{UserID: 2, IsAdmin: true}, []int64{item.ID}, 1, nil)
		if err != nil || !result[0].OK {
			t.Fatalf("assign=%+v err=%v", result, err)
		}
	}
	f.start(t)
	eventually(t, "both uploads imported", func() bool { return f.count(t, `SELECT count(*) FROM books`) == 2 })
	for _, visibility := range []string{"public", "private"} {
		var owner int64
		if err := f.db.Reader.QueryRow(`SELECT owner_id FROM books WHERE visibility=?`, visibility).Scan(&owner); err != nil || owner != 1 {
			t.Fatalf("%s owner=%d err=%v", visibility, owner, err)
		}
	}
}
