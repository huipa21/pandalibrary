package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"

	"pandalibrary/internal/db"
)

func TestShelfCursorSupportsMaximumLengthNames(t *testing.T) {
	fixture := newCatalogFixture(t)
	reader := Viewer{UserID: 2}
	first := createTestShelf(t, fixture.service, reader, "private", strings.Repeat("<", 1024))
	second := createTestShelf(t, fixture.service, reader, "private", strings.Repeat(">", 1024))
	page, err := fixture.service.ListShelves(context.Background(), reader, PageOptions{Limit: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].SystemKey == nil || *page.Items[0].SystemKey != SystemShelfFavorites || page.NextCursor == nil {
		t.Fatalf("system shelf page = %+v, %v", page, err)
	}
	page, err = fixture.service.ListShelves(context.Background(), reader, PageOptions{Limit: 1, Cursor: *page.NextCursor})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != first.ID || page.NextCursor == nil {
		t.Fatalf("first maximum-name page = %+v, %v", page, err)
	}
	page, err = fixture.service.ListShelves(context.Background(), reader, PageOptions{Limit: 1, Cursor: *page.NextCursor})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != second.ID || page.NextCursor != nil {
		t.Fatalf("second maximum-name page = %+v, %v", page, err)
	}
}

func TestShelfPaginationAndCursorBounds(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	reader, admin := Viewer{UserID: 2}, Viewer{UserID: 1, IsAdmin: true}
	shelf := createTestShelf(t, fixture.service, reader, "private", "Paged books")
	otherShelf := createTestShelf(t, fixture.service, reader, "private", "Other books")
	err := db.WithTx(ctx, fixture.db.Writer, func(tx *sql.Tx) error {
		for i := 0; i < 105; i++ {
			id := int64(1000 + i)
			title := fmt.Sprintf("Book %03d", i)
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
				VALUES (?, 10, ?, ?, 1, 1)`, id, title, title); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at)
				VALUES (?, ?, ?, 2, 1)`, shelf.ID, id, i/3); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO shelves (kind, owner_id, name, created_by, created_at, updated_at)
				VALUES ('private', 2, ?, 2, 1, 1)`, fmt.Sprintf("Shelf %03d", i)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := fixture.service.ListShelfBooks(ctx, reader, shelf.ID, PageOptions{})
	if err != nil || len(first.Items) != 50 || first.NextCursor == nil {
		t.Fatalf("default book page = %d, cursor %v, error %v", len(first.Items), first.NextCursor, err)
	}
	maxPage, err := fixture.service.ListShelfBooks(ctx, reader, shelf.ID, PageOptions{Limit: 100})
	if err != nil || len(maxPage.Items) != 100 || maxPage.NextCursor == nil {
		t.Fatalf("maximum book page = %d, cursor %v, error %v", len(maxPage.Items), maxPage.NextCursor, err)
	}
	last, err := fixture.service.ListShelfBooks(ctx, reader, shelf.ID, PageOptions{Limit: 100, Cursor: *maxPage.NextCursor})
	if err != nil || len(last.Items) != 5 || last.NextCursor != nil {
		t.Fatalf("last book page = %d, cursor %v, error %v", len(last.Items), last.NextCursor, err)
	}
	want := make([]int64, 105)
	for i := range want {
		want[i] = int64(1000 + i)
	}
	for _, limit := range []int{1, 7, 50, 100} {
		got := shelfBookIDs(t, fixture.service, reader, shelf.ID, limit)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("limit %d book IDs = %v, want %v", limit, got, want)
		}
	}
	for _, test := range []struct {
		name    string
		viewer  Viewer
		shelfID int64
		page    PageOptions
	}{
		{"negative limit", reader, shelf.ID, PageOptions{Limit: -1}},
		{"oversized limit", reader, shelf.ID, PageOptions{Limit: 101}},
		{"malformed cursor", reader, shelf.ID, PageOptions{Cursor: "%%%"}},
		{"oversized cursor", reader, shelf.ID, PageOptions{Cursor: strings.Repeat("x", maxCursorBytes+1)}},
		{"viewer changed", admin, shelf.ID, PageOptions{Cursor: *first.NextCursor}},
		{"shelf changed", reader, otherShelf.ID, PageOptions{Cursor: *first.NextCursor}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := fixture.service.ListShelfBooks(ctx, test.viewer, test.shelfID, test.page); !errors.Is(err, ErrInvalid) {
				t.Fatalf("error = %v, want invalid", err)
			}
		})
	}
	zero := int64(0)
	if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, 1104, &zero); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.ListShelfBooks(ctx, reader, shelf.ID, PageOptions{Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("old cursor after reorder = %v", err)
	}
	want = append([]int64{1104}, want[:104]...)
	assertShelfOrder(t, fixture, shelf.ID, want)
	if got := shelfBookIDs(t, fixture.service, reader, shelf.ID, 7); !reflect.DeepEqual(got, want) {
		t.Fatalf("pagination after reorder = %v", got)
	}
	shelfPage, err := fixture.service.ListShelves(ctx, reader, PageOptions{})
	if err != nil || len(shelfPage.Items) != 50 || shelfPage.NextCursor == nil {
		t.Fatalf("default shelf page = %d, cursor %v, error %v", len(shelfPage.Items), shelfPage.NextCursor, err)
	}
	maxShelfPage, err := fixture.service.ListShelves(ctx, reader, PageOptions{Limit: 100})
	if err != nil || len(maxShelfPage.Items) != 100 || maxShelfPage.NextCursor == nil {
		t.Fatalf("maximum shelf page = %d, cursor %v, error %v", len(maxShelfPage.Items), maxShelfPage.NextCursor, err)
	}
	lastShelves, err := fixture.service.ListShelves(ctx, reader, PageOptions{Limit: 100, Cursor: *maxShelfPage.NextCursor})
	if err != nil || len(lastShelves.Items) != 8 || lastShelves.NextCursor != nil {
		t.Fatalf("last shelf page = %d, cursor %v, error %v", len(lastShelves.Items), lastShelves.NextCursor, err)
	}
	seen := make(map[int64]bool)
	for _, page := range []Page[Shelf]{maxShelfPage, lastShelves} {
		for _, item := range page.Items {
			if seen[item.ID] {
				t.Fatalf("shelf %d appeared twice", item.ID)
			}
			seen[item.ID] = true
		}
	}
	if len(seen) != 108 {
		t.Fatalf("listed %d shelves, want 108 including Favorites", len(seen))
	}
	for _, test := range []struct {
		viewer Viewer
		page   PageOptions
	}{
		{reader, PageOptions{Limit: 101}},
		{reader, PageOptions{Limit: -1}},
		{admin, PageOptions{Cursor: *shelfPage.NextCursor}},
		{reader, PageOptions{Cursor: *first.NextCursor}},
		{reader, PageOptions{Cursor: "invalid"}},
	} {
		if _, err := fixture.service.ListShelves(ctx, test.viewer, test.page); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid shelf page = %v", err)
		}
	}
}

func TestShelfMutationsRollBackOnOrderFailure(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}
	shelf := createTestShelf(t, fixture.service, reader, "private", "Atomic")
	for _, id := range []int64{101, 104} {
		if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, id, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		VALUES (105, 10, 'New book', 'new book', 1, 1);
		CREATE TRIGGER test_fail_shelf_order BEFORE UPDATE OF position ON shelf_books
		BEGIN SELECT RAISE(ABORT, 'deliberate test failure'); END`); err != nil {
		t.Fatal(err)
	}
	zero := int64(0)
	if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, 105, &zero); err == nil {
		t.Fatal("insertion succeeded despite a failed reorder")
	}
	assertShelfOrder(t, fixture, shelf.ID, []int64{101, 104})
	if err := fixture.service.RemoveShelfBook(ctx, reader, shelf.ID, 101); err == nil {
		t.Fatal("deletion succeeded despite a failed reorder")
	}
	assertShelfOrder(t, fixture, shelf.ID, []int64{101, 104})
}

func TestConcurrentShelfMutationsKeepEveryBook(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}
	shelf := createTestShelf(t, fixture.service, reader, "private", "Concurrent")
	const count = 24
	err := db.WithTx(ctx, fixture.db.Writer, func(tx *sql.Tx) error {
		for i := 0; i < count; i++ {
			title := fmt.Sprintf("Concurrent %d", i)
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
				VALUES (?, 10, ?, ?, 1, 1)`, 2000+i, title, title); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	failures := make(chan error, count)
	for i := 0; i < count; i++ {
		workers.Go(func() {
			zero := int64(0)
			if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, int64(2000+i), &zero); err != nil {
				failures <- err
			}
		})
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		t.Errorf("concurrent add: %v", err)
	}
	ids, positions := rawShelfOrder(t, fixture, shelf.ID)
	if len(ids) != count {
		t.Fatalf("concurrent members = %v, want %d", ids, count)
	}
	for index, position := range positions {
		if position != int64(index) {
			t.Fatalf("concurrent positions = %v", positions)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for index, id := range ids {
		if id != int64(2000+index) {
			t.Fatalf("concurrent members = %v", ids)
		}
	}
}

func TestConcurrentShelfNameConflicts(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}
	const count = 16
	var workers sync.WaitGroup
	results := make(chan error, count)
	for range count {
		workers.Go(func() {
			_, err := fixture.service.CreateShelf(ctx, reader, ShelfInput{Kind: "private", Name: "Same"})
			results <- err
		})
	}
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrConflict):
			conflicts++
		default:
			t.Errorf("unexpected concurrent create error: %v", err)
		}
	}
	if successes != 1 || conflicts != count-1 {
		t.Fatalf("concurrent creates = %d successes, %d conflicts", successes, conflicts)
	}
}

func TestShelfOrderAgainstVisibleIndexModel(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}
	shelf := createTestShelf(t, fixture.service, reader, "private", "Model")
	if _, err := fixture.db.Writer.ExecContext(ctx, `
					INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
					(105, 10, '105', '105', 1, 1), (106, 10, '106', '106', 1, 1),
					(107, 10, '107', '107', 1, 1), (108, 10, '108', '108', 1, 1);
					INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at) VALUES
					(?, 102, 0, 1, 1), (?, 103, 0, 1, 1)`, shelf.ID, shelf.ID); err != nil {
		t.Fatal(err)
	}
	visibleBooks := []int64{101, 104, 105, 106, 107, 108}
	var model []int64
	random := rand.New(rand.NewSource(1234))
	for step := 0; step < 200; step++ {
		id := visibleBooks[random.Intn(len(visibleBooks))]
		index := slices.Index(model, id)
		switch random.Intn(3) {
		case 0:
			if err := fixture.service.RemoveShelfBook(ctx, reader, shelf.ID, id); err != nil {
				t.Fatalf("step %d remove %d: %v", step, id, err)
			}
			if index >= 0 {
				model = slices.Delete(model, index, index+1)
			}
		case 1:
			if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, id, nil); err != nil {
				t.Fatalf("step %d append %d: %v", step, id, err)
			}
			if index < 0 {
				model = append(model, id)
			}
		default:
			position := int64(random.Intn(len(visibleBooks) + 3))
			if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, id, &position); err != nil {
				t.Fatalf("step %d insert %d at %d: %v", step, id, position, err)
			}
			if index >= 0 {
				model = slices.Delete(model, index, index+1)
			}
			insertAt := min(int(position), len(model))
			model = slices.Insert(model, insertAt, id)
		}
		if got := shelfBookIDs(t, fixture.service, reader, shelf.ID, 2); !slices.Equal(got, model) {
			t.Fatalf("step %d visible order = %v, want %v", step, got, model)
		}
		rawIDs, positions := rawShelfOrder(t, fixture, shelf.ID)
		for index, position := range positions {
			if position != int64(index) {
				t.Fatalf("step %d positions = %v", step, positions)
			}
		}
		if hidden, inaccessible := slices.Index(rawIDs, int64(102)), slices.Index(rawIDs, int64(103)); hidden < 0 || inaccessible < 0 || hidden > inaccessible {
			t.Fatalf("step %d lost or reordered hidden members: %v", step, rawIDs)
		}
	}
}
