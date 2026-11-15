package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/trash"
)

func TestReviewTrashRecreationAndModeration(t *testing.T) {
	f := newCatalogHTTPFixture(t)
	ctx := context.Background()
	authn, err := auth.NewService(ctx, f.db.Writer, f.db.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	store, err := blobstore.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	books, err := catalog.NewService(f.db.Writer, f.db.Reader, store)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
	f.router, err = NewRouter(RouterOptions{
		Database: f.db.Reader, Ready: func() bool { return true },
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("test")}},
		Logger: logger, MaxBodyBytes: 2 << 20,
		Mounts: []Mount{ReviewMount(books, authn, logger), TrashMount(trash.NewService(f.db.Writer), authn, logger)},
	})
	if err != nil {
		t.Fatal(err)
	}
	save := func(cookie *http.Cookie, body string) catalog.Review {
		t.Helper()
		res := f.request(http.MethodPut, "/api/v1/books/101/reviews/me", strings.NewReader(`{"body":"`+body+`"}`), cookie, nil)
		if res.Code != http.StatusOK {
			t.Fatalf("save review: %d %s", res.Code, res.Body.String())
		}
		var payload struct {
			Review catalog.Review `json:"review"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Review
	}
	list := func(cookie *http.Cookie) []trash.Item {
		t.Helper()
		res := f.request(http.MethodGet, "/api/v1/trash?type=annotation", nil, cookie, nil)
		if res.Code != http.StatusOK {
			t.Fatalf("list trash: %d %s", res.Code, res.Body.String())
		}
		var payload struct {
			Items []trash.Item `json:"items"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload.Items
	}
	act := func(method, path, id string, cookie *http.Cookie) int {
		t.Helper()
		body := fmt.Sprintf(`{"items":[{"id":%q,"type":"annotation"}]}`, id)
		return f.request(method, path, strings.NewReader(body), cookie, nil).Code
	}
	old := save(f.reader, "old review")
	if _, err := f.db.Writer.ExecContext(ctx, `CREATE TRIGGER fail_review_delete BEFORE DELETE ON book_reviews
		BEGIN SELECT RAISE(ABORT, 'delete failed'); END`); err != nil {
		t.Fatal(err)
	}
	expectShelfStatus(t, f.request(http.MethodDelete, "/api/v1/books/101/reviews/me", nil, f.reader, nil), http.StatusInternalServerError)
	if items := list(f.reader); len(items) != 0 {
		t.Fatalf("failed deletion left a trash snapshot: %+v", items)
	}
	if _, err := f.db.Writer.ExecContext(ctx, `DROP TRIGGER fail_review_delete`); err != nil {
		t.Fatal(err)
	}
	expectShelfStatus(t, f.request(http.MethodDelete, "/api/v1/books/101/reviews/me", nil, f.reader, nil), http.StatusNoContent)
	items := list(f.reader)
	if len(items) != 1 || items[0].Title != "old review" {
		t.Fatalf("deleted review trash: %+v", items)
	}
	ref := items[0].ID
	if items := list(f.other); len(items) != 0 {
		t.Fatalf("another user sees review: %+v", items)
	}
	save(f.reader, "new review")
	if status := act(http.MethodPost, "/api/v1/trash/restore", ref, f.reader); status != http.StatusConflict {
		t.Fatalf("restore over newer review: %d", status)
	}
	expectShelfStatus(t, f.request(http.MethodDelete, "/api/v1/books/101/reviews/me", nil, f.reader, nil), http.StatusNoContent)
	adminReview := save(f.admin, "admin review")
	if status := act(http.MethodPost, "/api/v1/trash/restore", ref, f.reader); status != http.StatusNoContent {
		t.Fatalf("restore review: %d", status)
	}
	var restoredID int64
	var restoredBody string
	if err := f.db.Reader.QueryRowContext(ctx, `SELECT id,body FROM book_reviews WHERE book_id=101 AND user_id=2`).Scan(&restoredID, &restoredBody); err != nil || restoredBody != old.Body || restoredID == adminReview.ID {
		t.Fatalf("restored review = %d %q, %v", restoredID, restoredBody, err)
	}
	moderate := fmt.Sprintf("/api/v1/books/101/reviews/%d", restoredID)
	expectShelfStatus(t, f.request(http.MethodDelete, moderate, nil, f.admin, nil), http.StatusNoContent)
	adminItems := list(f.admin)
	if len(adminItems) != 1 || adminItems[0].Title != old.Body {
		t.Fatalf("moderated trash: %+v", adminItems)
	}
	moderated := adminItems[0].ID
	if status := act(http.MethodPost, "/api/v1/trash/restore", moderated, f.reader); status != http.StatusNotFound {
		t.Fatalf("owner restored moderated review: %d", status)
	}
	if status := act(http.MethodPost, "/api/v1/trash/restore", moderated, f.admin); status != http.StatusNoContent {
		t.Fatalf("admin restore: %d", status)
	}
	expectShelfStatus(t, f.request(http.MethodDelete, moderate, nil, f.admin, nil), http.StatusNoContent)
	adminItems = list(f.admin)
	if len(adminItems) != 1 {
		t.Fatalf("moderated trash after second delete: %+v", adminItems)
	}
	if status := act(http.MethodDelete, "/api/v1/trash", adminItems[0].ID, f.admin); status != http.StatusNoContent {
		t.Fatalf("purge review: %d", status)
	}
	if items := list(f.admin); len(items) != 0 {
		t.Fatalf("purged review remains: %+v", items)
	}
	if err := books.DeleteBook(ctx, catalog.Viewer{UserID: 1, IsAdmin: true}, 101); err != nil {
		t.Fatal(err)
	}
	if items := list(f.reader); len(items) != 0 {
		t.Fatalf("review visible with trashed book: %+v", items)
	}
	if err := trash.NewService(f.db.Writer).Apply(ctx, catalog.Viewer{UserID: 1, IsAdmin: true}, []trash.Ref{{Type: "book", ID: "101"}}, true); err != nil {
		t.Fatal(err)
	}
	if items := list(f.reader); len(items) != 1 || items[0].Title != "new review" {
		t.Fatalf("book restore lost review trash: %+v", items)
	}
}
