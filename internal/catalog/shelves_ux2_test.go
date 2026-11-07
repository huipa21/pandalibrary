package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func favoritesID(t *testing.T, service *Service, viewer Viewer) int64 {
	t.Helper()
	shelf, err := service.GetSystemShelf(context.Background(), viewer, SystemShelfFavorites)
	if err != nil || shelf.ShelfID == nil || shelf.Key != SystemShelfFavorites || shelf.Mode != ShelfModeManual {
		t.Fatalf("favorites = %+v, %v", shelf, err)
	}
	return *shelf.ShelfID
}

func systemBookIDs(t *testing.T, service *Service, viewer Viewer, key string, limit int) []int64 {
	t.Helper()
	var ids []int64
	options := PageOptions{Limit: limit}
	for {
		page, err := service.ListSystemShelfBooks(context.Background(), viewer, key, options)
		if err != nil {
			t.Fatalf("list %s books: %v", key, err)
		}
		for _, book := range page.Items {
			ids = append(ids, book.ID)
		}
		if page.NextCursor == nil {
			return ids
		}
		options.Cursor = *page.NextCursor
	}
}

func rules(match string, conditions ...RuleCondition) *RuleSet {
	return &RuleSet{Match: match, Conditions: conditions}
}

func condition(field, op, value string) RuleCondition {
	return RuleCondition{Field: field, Op: op, Value: json.RawMessage(value)}
}

func createAutomaticShelf(t *testing.T, service *Service, viewer Viewer, name string, set *RuleSet) Shelf {
	t.Helper()
	shelf, err := service.CreateShelf(context.Background(), viewer, ShelfInput{
		Kind: "private", Mode: ShelfModeAutomatic, Name: name, Rules: set,
	})
	if err != nil {
		t.Fatalf("create automatic shelf %q: %v", name, err)
	}
	return shelf
}

func TestFavoritesSystemShelf(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin, reader := Viewer{UserID: 1, IsAdmin: true}, Viewer{UserID: 2}
	id := favoritesID(t, fixture.service, reader)
	if again := favoritesID(t, fixture.service, reader); again != id {
		t.Fatalf("favorites ID changed from %d to %d", id, again)
	}
	shelf, err := fixture.service.GetShelf(ctx, reader, id)
	if err != nil || shelf.SystemKey == nil || *shelf.SystemKey != SystemShelfFavorites || shelf.Kind != "private" ||
		shelf.Mode != ShelfModeManual || shelf.Rules != nil || shelf.Name != "Favorites" {
		t.Fatalf("favorites shelf DTO = %+v, %v", shelf, err)
	}
	custom, err := fixture.service.CreateShelf(ctx, reader, ShelfInput{Kind: "private", Name: "favorites"})
	if err != nil {
		t.Fatalf("custom shelf named like the system shelf: %v", err)
	}
	if custom.SystemKey != nil || custom.ID == id {
		t.Fatalf("custom shelf = %+v", custom)
	}

	for name, patch := range map[string]ShelfPatch{
		"rename": {Name: Optional[string]{Set: true, Value: ptrString("Loved")}},
		"mode":   {Mode: Optional[string]{Set: true, Value: ptrString(ShelfModeAutomatic)}},
		"rules":  {Rules: Optional[RuleSet]{Set: true, Value: rules("all", condition("title", "contains", `"x"`))}},
	} {
		if _, err := fixture.service.UpdateShelf(ctx, reader, id, patch); !errors.Is(err, ErrConflict) {
			t.Fatalf("%s favorites = %v, want conflict", name, err)
		}
	}
	if err := fixture.service.DeleteShelf(ctx, reader, id); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete favorites = %v, want conflict", err)
	}
	updated, err := fixture.service.UpdateShelf(ctx, reader, id, ShelfPatch{
		Description: Optional[string]{Set: true, Value: ptrString("best")},
	})
	if err != nil || updated.Description == nil || *updated.Description != "best" || updated.Name != "Favorites" {
		t.Fatalf("favorites description update = %+v, %v", updated, err)
	}

	if err := fixture.service.PutShelfBook(ctx, reader, id, 104, nil); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.PutShelfBook(ctx, reader, id, 101, nil); err != nil {
		t.Fatal(err)
	}
	if got := systemBookIDs(t, fixture.service, reader, SystemShelfFavorites, 1); !reflect.DeepEqual(got, []int64{104, 101}) {
		t.Fatalf("favorites books = %v, want manual order [104 101]", got)
	}
	meta, err := fixture.service.GetSystemShelf(ctx, reader, SystemShelfFavorites)
	if err != nil || meta.VisibleBookCount != 2 {
		t.Fatalf("favorites metadata = %+v, %v", meta, err)
	}
	if err := fixture.service.RemoveShelfBook(ctx, reader, id, 101); err != nil {
		t.Fatal(err)
	}

	if _, err := fixture.service.GetShelf(ctx, admin, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("admin reading another user's favorites = %v, want not found", err)
	}
	if err := fixture.service.PutShelfBook(ctx, admin, id, 101, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("admin adding to another user's favorites = %v, want not found", err)
	}
	page, err := fixture.service.ListShelves(ctx, admin, PageOptions{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Items {
		if item.ID == id {
			t.Fatal("admin shelf list exposed another user's favorites")
		}
	}
	if len(page.Items) != 2 || page.Items[1].ID != custom.ID || page.Items[0].SystemKey == nil || *page.Items[0].OwnerID != 1 {
		t.Fatalf("admin list = %+v, want own favorites then reader's custom shelf", page.Items)
	}

	for _, key := range []string{"", "Favorites", "recent", "1"} {
		if _, err := fixture.service.GetSystemShelf(ctx, reader, key); !errors.Is(err, ErrNotFound) {
			t.Fatalf("system key %q = %v, want not found", key, err)
		}
		if _, err := fixture.service.ListSystemShelfBooks(ctx, reader, key, PageOptions{}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("system key %q books = %v, want not found", key, err)
		}
	}
}

func TestFavoritesConcurrentProvisioning(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 4}
	if _, err := fixture.db.Writer.ExecContext(ctx, "DELETE FROM shelves WHERE owner_id = 4"); err != nil {
		t.Fatal(err)
	}
	const workers = 16
	ids := make([]int64, workers)
	errs := make([]error, workers)
	var wait sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			<-start
			if i%2 == 0 {
				var shelf SystemShelf
				shelf, errs[i] = fixture.service.GetSystemShelf(ctx, viewer, SystemShelfFavorites)
				if shelf.ShelfID != nil {
					ids[i] = *shelf.ShelfID
				}
				return
			}
			var page Page[Shelf]
			page, errs[i] = fixture.service.ListShelves(ctx, viewer, PageOptions{})
			if len(page.Items) > 0 {
				ids[i] = page.Items[0].ID
			}
		}(i)
	}
	close(start)
	wait.Wait()
	for i := range ids {
		if errs[i] != nil || ids[i] == 0 || ids[i] != ids[0] {
			t.Fatalf("worker %d = %d, %v (first %d)", i, ids[i], errs[i], ids[0])
		}
	}
	var count int
	if err := fixture.db.Writer.QueryRowContext(ctx,
		"SELECT count(*) FROM shelves WHERE owner_id = 4 AND system_key = 'favorites'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("favorites rows = %d, want exactly 1", count)
	}
}

func TestUnshelvedSystemShelf(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin, reader, other := Viewer{UserID: 1, IsAdmin: true}, Viewer{UserID: 2}, Viewer{UserID: 3}
	assertUnshelved := func(viewer Viewer, want []int64) {
		t.Helper()
		for _, limit := range []int{1, 2, 100} {
			if got := systemBookIDs(t, fixture.service, viewer, SystemShelfUnshelved, limit); !reflect.DeepEqual(got, want) {
				t.Fatalf("viewer %d unshelved (limit %d) = %v, want %v", viewer.UserID, limit, got, want)
			}
		}
		meta, err := fixture.service.GetSystemShelf(ctx, viewer, SystemShelfUnshelved)
		if err != nil || meta.VisibleBookCount != int64(len(want)) || meta.ShelfID != nil ||
			meta.Mode != ShelfModeAutomatic || meta.Key != SystemShelfUnshelved {
			t.Fatalf("viewer %d unshelved metadata = %+v, %v", viewer.UserID, meta, err)
		}
	}
	assertUnshelved(reader, []int64{101, 104})
	assertUnshelved(admin, []int64{102, 101, 104})
	assertUnshelved(other, []int64{103})

	mine := createTestShelf(t, fixture.service, reader, "private", "Mine")
	if err := fixture.service.PutShelfBook(ctx, reader, mine.ID, 101, nil); err != nil {
		t.Fatal(err)
	}
	assertUnshelved(reader, []int64{104})
	assertUnshelved(admin, []int64{102, 101, 104})

	if err := fixture.service.PutShelfBook(ctx, reader, favoritesID(t, fixture.service, reader), 104, nil); err != nil {
		t.Fatal(err)
	}
	shared := createTestShelf(t, fixture.service, admin, "shared", "Shared")
	if err := fixture.service.PutShelfBook(ctx, admin, shared.ID, 104, nil); err != nil {
		t.Fatal(err)
	}
	createAutomaticShelf(t, fixture.service, reader, "Auto", rules("all", condition("title", "contains", `"tie"`)))
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO shelves (id, kind, owner_id, name, created_by, created_at, updated_at) VALUES (900, 'private', 3, 'Theirs', 3, 1, 1);
		INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at) VALUES (900, 104, 0, 3, 1)`); err != nil {
		t.Fatal(err)
	}
	assertUnshelved(reader, []int64{104})

	// A hidden book on the reader's own shelf neither appears nor counts.
	if _, err := fixture.db.Writer.ExecContext(ctx,
		`INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at) VALUES (?, 102, 5, 1, 1)`, mine.ID); err != nil {
		t.Fatal(err)
	}
	assertUnshelved(admin, []int64{102, 101, 104})
	assertUnshelved(reader, []int64{104})

	first, err := fixture.service.ListSystemShelfBooks(ctx, admin, SystemShelfUnshelved, PageOptions{Limit: 1})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("admin first unshelved page = %+v, %v", first, err)
	}
	if _, err := fixture.service.ListSystemShelfBooks(ctx, reader, SystemShelfUnshelved,
		PageOptions{Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cross-viewer unshelved cursor = %v, want invalid", err)
	}
	if _, err := fixture.service.ListSystemShelfBooks(ctx, admin, SystemShelfFavorites,
		PageOptions{Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unshelved cursor reused for favorites = %v, want invalid", err)
	}
	for _, page := range []PageOptions{{Limit: -1}, {Limit: 101}, {Cursor: "%%%"}} {
		if _, err := fixture.service.ListSystemShelfBooks(ctx, reader, SystemShelfUnshelved, page); !errors.Is(err, ErrInvalid) {
			t.Fatalf("page %+v = %v, want invalid", page, err)
		}
	}
}

func TestAutomaticShelfValidation(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin, reader := Viewer{UserID: 1, IsAdmin: true}, Viewer{UserID: 2}
	valid := rules("all", condition("title", "contains", `"tie"`))
	for name, input := range map[string]ShelfInput{
		"shared automatic":       {Kind: "shared", Mode: ShelfModeAutomatic, Name: "S", Rules: valid},
		"automatic without rule": {Kind: "private", Mode: ShelfModeAutomatic, Name: "S"},
		"manual with rules":      {Kind: "private", Mode: ShelfModeManual, Name: "S", Rules: valid},
		"unknown mode":           {Kind: "private", Mode: "smart", Name: "S", Rules: valid},
	} {
		viewer := reader
		if input.Kind == "shared" {
			viewer = admin
		}
		if _, err := fixture.service.CreateShelf(ctx, viewer, input); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s = %v, want invalid", name, err)
		}
	}
	tooMany := make([]RuleCondition, 21)
	for i := range tooMany {
		tooMany[i] = condition("format", "eq", `"epub"`)
	}
	for name, set := range map[string]*RuleSet{
		"bad match":          rules("none", condition("title", "contains", `"x"`)),
		"no conditions":      rules("all"),
		"too many":           {Match: "all", Conditions: tooMany},
		"unknown field":      rules("all", condition("publisher", "eq", `"x"`)),
		"title op":           rules("all", condition("title", "eq", `"x"`)),
		"id op":              rules("all", condition("author_id", "contains", `1`)),
		"id string":          rules("all", condition("author_id", "eq", `"1"`)),
		"id fraction":        rules("all", condition("tag_id", "eq", `1.5`)),
		"id exponent":        rules("all", condition("tag_id", "eq", `1e2`)),
		"id zero":            rules("all", condition("series_id", "eq", `0`)),
		"id negative":        rules("all", condition("series_id", "eq", `-1`)),
		"id overflow":        rules("all", condition("series_id", "eq", `99999999999999999999`)),
		"id object":          rules("all", condition("series_id", "eq", `{"id":1}`)),
		"blank title":        rules("all", condition("title", "contains", `"   "`)),
		"title control":      rules("all", condition("title", "contains", `"a\u0000b"`)),
		"long title":         rules("all", condition("title", "contains", `"`+strings.Repeat("x", 201)+`"`)),
		"title number":       rules("any", condition("title", "contains", `5`)),
		"language injection": rules("all", condition("language", "eq", `"en' OR 1=1 --"`)),
		"format unknown":     rules("all", condition("format", "eq", `"exe"`)),
		"status unknown":     rules("all", condition("reading_status", "eq", `"done"`)),
		"null value":         rules("all", condition("format", "eq", `null`)),
		"nested rules":       rules("all", condition("rules", "eq", `{"match":"all"}`)),
	} {
		if _, err := fixture.service.CreateShelf(ctx, reader, ShelfInput{
			Kind: "private", Mode: ShelfModeAutomatic, Name: "Invalid", Rules: set,
		}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s = %v, want invalid", name, err)
		}
	}
	shelf := createAutomaticShelf(t, fixture.service, reader, "Auto", rules("any",
		condition("title", "contains", `"%' OR 1=1 --"`), condition("author_id", "eq", ` 1 `)))
	if shelf.Mode != ShelfModeAutomatic || shelf.Rules == nil || shelf.SystemKey != nil ||
		string(shelf.Rules.Conditions[1].Value) != "1" {
		t.Fatalf("automatic shelf DTO = %+v", shelf)
	}
	manual := createTestShelf(t, fixture.service, reader, "private", "Manual")
	for name, test := range map[string]struct {
		id    int64
		patch ShelfPatch
		want  error
	}{
		"automatic to manual": {shelf.ID, ShelfPatch{Mode: Optional[string]{Set: true, Value: ptrString(ShelfModeManual)}}, ErrConflict},
		"manual to automatic": {manual.ID, ShelfPatch{Mode: Optional[string]{Set: true, Value: ptrString(ShelfModeAutomatic)}}, ErrConflict},
		"rules on manual":     {manual.ID, ShelfPatch{Rules: Optional[RuleSet]{Set: true, Value: valid}}, ErrConflict},
		"null rules":          {shelf.ID, ShelfPatch{Rules: Optional[RuleSet]{Set: true}}, ErrInvalid},
		"null mode":           {shelf.ID, ShelfPatch{Mode: Optional[string]{Set: true}}, ErrInvalid},
		"invalid rules":       {shelf.ID, ShelfPatch{Rules: Optional[RuleSet]{Set: true, Value: rules("all")}}, ErrInvalid},
	} {
		if _, err := fixture.service.UpdateShelf(ctx, reader, test.id, test.patch); !errors.Is(err, test.want) {
			t.Fatalf("%s = %v, want %v", name, err, test.want)
		}
	}
	same, err := fixture.service.UpdateShelf(ctx, reader, shelf.ID, ShelfPatch{
		Mode: Optional[string]{Set: true, Value: ptrString(ShelfModeAutomatic)},
	})
	if err != nil || same.Mode != ShelfModeAutomatic {
		t.Fatalf("unchanged mode patch = %+v, %v", same, err)
	}
	if err := fixture.service.PutShelfBook(ctx, reader, shelf.ID, 101, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("put automatic membership = %v, want conflict", err)
	}
	if err := fixture.service.RemoveShelfBook(ctx, reader, shelf.ID, 101); !errors.Is(err, ErrConflict) {
		t.Fatalf("remove automatic membership = %v, want conflict", err)
	}
	var stored int
	if err := fixture.db.Writer.QueryRowContext(ctx, "SELECT count(*) FROM shelf_books WHERE shelf_id = ?", shelf.ID).Scan(&stored); err != nil || stored != 0 {
		t.Fatalf("automatic shelf stored membership rows = %d, %v", stored, err)
	}
}

func TestAutomaticShelfExtendedReadingStatuses(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 1, IsAdmin: true}
	tests := []struct {
		status string
		bookID int64
	}{
		{"on_hold", 101},
		{"rereading", 102},
		{"skimmed", 104},
	}
	for _, test := range tests {
		if _, err := fixture.db.Writer.ExecContext(ctx,
			`INSERT INTO user_books (user_id, book_id, status, updated_at, rev) VALUES (?, ?, ?, 1, 1)`,
			viewer.UserID, test.bookID, test.status,
		); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range tests {
		t.Run(test.status, func(t *testing.T) {
			shelf := createAutomaticShelf(t, fixture.service, viewer, test.status,
				rules("all", condition("reading_status", "eq", `"`+test.status+`"`)))
			if shelf.VisibleBookCount != 1 {
				t.Fatalf("count = %d, want 1", shelf.VisibleBookCount)
			}
			if got := shelfBookIDs(t, fixture.service, viewer, shelf.ID, 1); !reflect.DeepEqual(got, []int64{test.bookID}) {
				t.Fatalf("books = %v, want [%d]", got, test.bookID)
			}
		})
	}
}

func TestAutomaticShelfRuleEvaluation(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin, reader := Viewer{UserID: 1, IsAdmin: true}, Viewer{UserID: 2}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		UPDATE books SET language = 'en' WHERE id = 102;
		UPDATE books SET language = 'zh-Hans', series_id = NULL WHERE id = 104;
		UPDATE book_files SET format = 'pdf' WHERE book_id = 104;
		INSERT INTO user_books (user_id, book_id, status, updated_at, rev) VALUES (1, 101, 'finished', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		set  *RuleSet
		want []int64
	}{
		{"title case-insensitive", rules("all", condition("title", "contains", `"TIE"`)), []int64{101, 104}},
		{"title literal percent", rules("all", condition("title", "contains", `"%"`)), nil},
		{"title injection", rules("all", condition("title", "contains", `"' OR 1=1 --"`)), nil},
		{"author", rules("all", condition("author_id", "eq", `1`)), []int64{102, 101, 104}},
		{"unknown author", rules("all", condition("author_id", "eq", `999`)), nil},
		{"tag", rules("all", condition("tag_id", "eq", `1`)), []int64{102, 101, 104}},
		{"series", rules("all", condition("series_id", "eq", `1`)), []int64{102, 101}},
		{"language", rules("all", condition("language", "eq", `"EN"`)), []int64{102}},
		{"language subtag", rules("all", condition("language", "eq", `"zh-hans"`)), []int64{104}},
		{"format", rules("all", condition("format", "eq", `"pdf"`)), []int64{104}},
		{"finished", rules("all", condition("reading_status", "eq", `"finished"`)), []int64{101}},
		{"unread default", rules("all", condition("reading_status", "eq", `"unread"`)), []int64{102, 104}},
		{"any", rules("any", condition("title", "contains", `"hidden"`), condition("format", "eq", `"pdf"`)), []int64{102, 104}},
		{"all", rules("all", condition("author_id", "eq", `1`), condition("format", "eq", `"epub"`)), []int64{102, 101}},
		{"all none", rules("all", condition("format", "eq", `"pdf"`), condition("format", "eq", `"epub"`)), nil},
		{"hidden book excluded", rules("all", condition("author_id", "eq", `2`)), nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			shelf := createAutomaticShelf(t, fixture.service, admin, test.name, test.set)
			if shelf.VisibleBookCount != int64(len(test.want)) {
				t.Fatalf("count = %d, want %d", shelf.VisibleBookCount, len(test.want))
			}
			for _, limit := range []int{1, 100} {
				if got := shelfBookIDs(t, fixture.service, admin, shelf.ID, limit); !reflect.DeepEqual(got, test.want) {
					t.Fatalf("limit %d books = %v, want %v", limit, got, test.want)
				}
			}
		})
	}

	// Membership is computed for the reading viewer: the reader cannot see 102, and
	// the reader's own reading status (not the admin's) applies.
	readerShelf := createAutomaticShelf(t, fixture.service, reader, "Reader auto", rules("all", condition("author_id", "eq", `1`)))
	if got := shelfBookIDs(t, fixture.service, reader, readerShelf.ID, 1); !reflect.DeepEqual(got, []int64{101, 104}) {
		t.Fatalf("reader automatic books = %v", got)
	}
	unread := createAutomaticShelf(t, fixture.service, reader, "Reader unread", rules("all", condition("reading_status", "eq", `"unread"`)))
	if got := shelfBookIDs(t, fixture.service, reader, unread.ID, 100); !reflect.DeepEqual(got, []int64{101, 104}) {
		t.Fatalf("reader unread books = %v", got)
	}
	adminView, err := fixture.service.GetShelf(ctx, admin, readerShelf.ID)
	if err != nil || adminView.VisibleBookCount != 3 {
		t.Fatalf("admin view of reader automatic shelf = %+v, %v", adminView, err)
	}

	first, err := fixture.service.ListShelfBooks(ctx, reader, readerShelf.ID, PageOptions{Limit: 1})
	if err != nil || first.NextCursor == nil {
		t.Fatalf("first automatic page = %+v, %v", first, err)
	}
	if _, err := fixture.service.ListShelfBooks(ctx, admin, readerShelf.ID, PageOptions{Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cross-viewer automatic cursor = %v, want invalid", err)
	}
	if _, err := fixture.service.ListShelfBooks(ctx, reader, unread.ID, PageOptions{Cursor: *first.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cross-shelf automatic cursor = %v, want invalid", err)
	}

	// Dynamic changes are reflected on the next read.
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (105, 10, 'Aardvark', 'aardvark', 1, 1);
		INSERT INTO book_authors (book_id, author_id, role, position) VALUES (105, 1, 'author', 0);
		INSERT INTO user_books (user_id, book_id, status, updated_at, rev) VALUES (2, 104, 'reading', 1, 2)`); err != nil {
		t.Fatal(err)
	}
	if got := shelfBookIDs(t, fixture.service, reader, readerShelf.ID, 2); !reflect.DeepEqual(got, []int64{105, 101, 104}) {
		t.Fatalf("automatic books after new book = %v", got)
	}
	if got := shelfBookIDs(t, fixture.service, reader, unread.ID, 2); !reflect.DeepEqual(got, []int64{105, 101}) {
		t.Fatalf("unread books after status change = %v", got)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `DELETE FROM book_authors WHERE book_id = 101`); err != nil {
		t.Fatal(err)
	}
	if got := shelfBookIDs(t, fixture.service, reader, readerShelf.ID, 100); !reflect.DeepEqual(got, []int64{105, 104}) {
		t.Fatalf("automatic books after metadata change = %v", got)
	}

	// Changing rules invalidates outstanding cursors.
	page, err := fixture.service.ListShelfBooks(ctx, reader, readerShelf.ID, PageOptions{Limit: 1})
	if err != nil || page.NextCursor == nil {
		t.Fatalf("page before rules change = %+v, %v", page, err)
	}
	updated, err := fixture.service.UpdateShelf(ctx, reader, readerShelf.ID, ShelfPatch{
		Rules: Optional[RuleSet]{Set: true, Value: rules("any", condition("tag_id", "eq", `1`))},
	})
	if err != nil || updated.Rules == nil || updated.Rules.Match != "any" || updated.VisibleBookCount != 2 {
		t.Fatalf("rules update = %+v, %v", updated, err)
	}
	if _, err := fixture.service.ListShelfBooks(ctx, reader, readerShelf.ID, PageOptions{Cursor: *page.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cursor after rules change = %v, want invalid", err)
	}
	if got := shelfBookIDs(t, fixture.service, reader, readerShelf.ID, 1); !reflect.DeepEqual(got, []int64{101, 104}) {
		t.Fatalf("books after rules change = %v", got)
	}
}
