package catalog

import (
	"context"
	"database/sql"
	"reflect"
	"testing"

	"pandalibrary/internal/db"
	"pandalibrary/internal/search"
)

func TestSearchUsesCatalogVisibility(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	if err := db.WithTx(ctx, fixture.db.Writer, func(tx *sql.Tx) error {
		for _, id := range []int64{101, 102, 103, 104} {
			if err := search.IndexBook(ctx, tx, id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	service, err := search.NewService(fixture.db.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range visibilityCases() {
		for _, query := range []string{"Shared", "Sh"} {
			t.Run(test.name+"/"+query, func(t *testing.T) {
				viewer := search.Viewer{UserID: test.viewer.UserID, IsAdmin: test.viewer.IsAdmin}
				got := make(map[int64]bool)
				var cursor string
				for {
					page, err := service.Search(ctx, viewer, query, search.PageOptions{Limit: 2, Cursor: cursor})
					if err != nil {
						t.Fatal(err)
					}
					for _, book := range page.Items {
						if got[book.ID] {
							t.Fatalf("book %d repeated across pages", book.ID)
						}
						got[book.ID] = true
					}
					if page.NextCursor == nil {
						break
					}
					cursor = *page.NextCursor
				}
				if !reflect.DeepEqual(got, test.visible) {
					t.Errorf("visible books = %v, want %v", got, test.visible)
				}
			})
		}
	}
}
