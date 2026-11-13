package catalog

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
)

func testRuleGroup(id, match string, conditions ...RuleCondition) RuleGroup {
	return RuleGroup{ID: id, Name: id, Rules: *rules(match, conditions...)}
}

func assertCollectionBooks(t *testing.T, fixture catalogFixture, viewer Viewer, shelfID int64, want ...int64) {
	t.Helper()
	got := shelfBookIDs(t, fixture.service, viewer, shelfID, 1)
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("collection books = %v, want %v", got, want)
	}
	shelf, err := fixture.service.GetShelf(context.Background(), viewer, shelfID)
	if err != nil || shelf.VisibleBookCount != int64(len(want)) {
		t.Fatalf("collection count = %d, want %d: %v", shelf.VisibleBookCount, len(want), err)
	}
}

func TestCollectionIndependentGroupsAndLiveMembership(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO library_access (library_id, user_id, granted_at) VALUES (20, 2, 1)`); err != nil {
		t.Fatal(err)
	}
	groups := []RuleGroup{
		testRuleGroup("first", "all", condition("title", "contains", `"Tie A"`), condition("author_id", "eq", `1`)),
		testRuleGroup("second", "any", condition("title", "contains", `"Secret"`), condition("reading_status", "eq", `"finished"`)),
	}
	shelf, err := fixture.service.CreateShelf(ctx, viewer, ShelfInput{Kind: "private", Name: "Mixed", RuleGroups: groups})
	if err != nil || !reflect.DeepEqual(shelf.RuleGroups, groups) || shelf.Mode != ShelfModeManual {
		t.Fatalf("create collection = %+v, %v", shelf, err)
	}
	assertCollectionBooks(t, fixture, viewer, shelf.ID, 101, 103)
	if err := fixture.service.PutShelfBook(ctx, viewer, shelf.ID, 104, nil); err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, viewer, shelf.ID, 101, 103, 104)
	if err := fixture.service.PutShelfBook(ctx, viewer, shelf.ID, 101, nil); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.RemoveShelfBook(ctx, viewer, shelf.ID, 101); err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, viewer, shelf.ID, 101, 103, 104)
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
			VALUES (105, 20, 'New book', 'new book', 1, 1);
		INSERT INTO user_books (user_id, book_id, status, updated_at, rev) VALUES (2, 105, 'finished', 1, 1);
		UPDATE books SET title = 'Changed title' WHERE id = 101`); err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, viewer, shelf.ID, 103, 104, 105)
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		UPDATE user_books SET status = 'reading', rev = 2 WHERE user_id = 2 AND book_id = 105;
		UPDATE books SET title = 'Secret new metadata' WHERE id = 101`); err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, viewer, shelf.ID, 101, 103, 104)
	page, err := fixture.service.ListShelfBooks(ctx, viewer, shelf.ID, PageOptions{Limit: 1})
	if err != nil || page.NextCursor == nil {
		t.Fatalf("first collection page = %+v, %v", page, err)
	}
	groups[0].Rules = *rules("all", condition("title", "contains", `"no match"`))
	if _, err := fixture.service.UpdateShelf(ctx, viewer, shelf.ID, ShelfPatch{
		RuleGroups: Optional[[]RuleGroup]{Set: true, Value: &groups},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.ListShelfBooks(ctx, viewer, shelf.ID, PageOptions{Cursor: *page.NextCursor}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cursor after group edit = %v, want invalid", err)
	}
}

func TestCollectionRemoveRuleProvenance(t *testing.T) {
	for _, remove := range []bool{false, true} {
		t.Run(map[bool]string{false: "retain default", true: "remove rule books"}[remove], func(t *testing.T) {
			fixture := newCatalogFixture(t)
			ctx := context.Background()
			viewer := Viewer{UserID: 1, IsAdmin: true}
			groups := []RuleGroup{
				testRuleGroup("broad", "all", condition("author_id", "eq", `1`)),
				testRuleGroup("overlap", "all", condition("title", "contains", `"Tie A"`)),
			}
			shelf, err := fixture.service.CreateShelf(ctx, viewer, ShelfInput{Kind: "private", Name: "Provenance", RuleGroups: groups})
			if err != nil {
				t.Fatal(err)
			}
			if err := fixture.service.PutShelfBook(ctx, viewer, shelf.ID, 104, nil); err != nil {
				t.Fatal(err)
			}
			groups = groups[1:]
			if _, err := fixture.service.UpdateShelf(ctx, viewer, shelf.ID, ShelfPatch{
				RuleGroups: Optional[[]RuleGroup]{Set: true, Value: &groups}, RemoveRuleBooks: remove,
			}); err != nil {
				t.Fatal(err)
			}
			want := []int64{101, 104}
			if !remove {
				want = append(want, 102)
			}
			assertCollectionBooks(t, fixture, viewer, shelf.ID, want...)
			groups = []RuleGroup{}
			if _, err := fixture.service.UpdateShelf(ctx, viewer, shelf.ID, ShelfPatch{
				RuleGroups: Optional[[]RuleGroup]{Set: true, Value: &groups}, RemoveRuleBooks: true,
			}); err != nil {
				t.Fatal(err)
			}
			if remove {
				assertCollectionBooks(t, fixture, viewer, shelf.ID, 104)
			} else {
				assertCollectionBooks(t, fixture, viewer, shelf.ID, 101, 102, 104)
			}
		})
	}
}

func TestSharedCollectionViewerPermissionsAndRetention(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin, reader, other := Viewer{UserID: 1, IsAdmin: true}, Viewer{UserID: 2}, Viewer{UserID: 3}
	groups := []RuleGroup{testRuleGroup("all-books", "all", condition("author_id", "eq", `1`))}
	collection, err := fixture.service.CreateShelf(ctx, admin, ShelfInput{Kind: "shared", Name: "Shared rules", RuleGroups: groups})
	if err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, admin, collection.ID, 101, 102, 104)
	assertCollectionBooks(t, fixture, reader, collection.ID, 101, 104)
	assertCollectionBooks(t, fixture, other, collection.ID, 103)
	assertCollectionBooks(t, fixture, Viewer{UserID: 4}, collection.ID)
	for _, operation := range []func() error{
		func() error {
			_, err := fixture.service.UpdateShelf(ctx, reader, collection.ID, ShelfPatch{RuleGroups: Optional[[]RuleGroup]{Set: true, Value: &groups}})
			return err
		},
		func() error { return fixture.service.PutShelfBook(ctx, reader, collection.ID, 101, nil) },
		func() error { return fixture.service.RemoveShelfBook(ctx, reader, collection.ID, 101) },
	} {
		if err := operation(); !errors.Is(err, ErrForbidden) {
			t.Fatalf("reader shared write = %v, want forbidden", err)
		}
	}
	groups = []RuleGroup{testRuleGroup("read", "all", condition("reading_status", "eq", `"finished"`))}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO user_books (user_id, book_id, status, updated_at, rev) VALUES (1, 101, 'finished', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.UpdateShelf(ctx, admin, collection.ID, ShelfPatch{
		RuleGroups: Optional[[]RuleGroup]{Set: true, Value: &groups}, RemoveRuleBooks: true,
	}); err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, admin, collection.ID, 101)
	assertCollectionBooks(t, fixture, reader, collection.ID)
	groups = []RuleGroup{}
	if _, err := fixture.service.UpdateShelf(ctx, admin, collection.ID, ShelfPatch{
		RuleGroups: Optional[[]RuleGroup]{Set: true, Value: &groups},
	}); err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, reader, collection.ID, 101)
	assertCollectionBooks(t, fixture, other, collection.ID)

	// Retention must not materialize the acting manager's hidden books into shared
	// manual membership, even when another account could otherwise see them.
	groups = []RuleGroup{testRuleGroup("broad", "all", condition("author_id", "eq", `1`))}
	retained, err := fixture.service.CreateShelf(ctx, admin, ShelfInput{Kind: "shared", Name: "Retained visible", RuleGroups: groups})
	if err != nil {
		t.Fatal(err)
	}
	groups = []RuleGroup{}
	if _, err := fixture.service.UpdateShelf(ctx, admin, retained.ID, ShelfPatch{
		RuleGroups: Optional[[]RuleGroup]{Set: true, Value: &groups},
	}); err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, reader, retained.ID, 101, 104)
	assertCollectionBooks(t, fixture, other, retained.ID)
}

func TestCollectionRuleGroupValidationAndLegacyCompatibility(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	group := testRuleGroup("valid", "all", condition("title", "contains", `"Tie"`))
	for name, groups := range map[string][]RuleGroup{
		"duplicate IDs": {group, group},
		"empty ID":      {{Name: "Name", Rules: group.Rules}},
		"invalid ID":    {{ID: "bad id", Name: "Name", Rules: group.Rules}},
		"empty name":    {{ID: "id", Rules: group.Rules}},
		"invalid rules": {{ID: "id", Name: "Name", Rules: RuleSet{Match: "none"}}},
		"too many":      make([]RuleGroup, 21),
	} {
		if _, err := fixture.service.CreateShelf(ctx, viewer, ShelfInput{Kind: "private", Name: name, RuleGroups: groups}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s = %v, want invalid", name, err)
		}
	}
	legacy := createAutomaticShelf(t, fixture.service, viewer, "Legacy", &group.Rules)
	if len(legacy.RuleGroups) != 1 || legacy.RuleGroups[0].ID != "legacy" {
		t.Fatalf("legacy groups = %+v", legacy.RuleGroups)
	}
	updated, err := fixture.service.UpdateShelf(ctx, viewer, legacy.ID, ShelfPatch{
		Rules: Optional[RuleSet]{Set: true, Value: rules("all", condition("title", "contains", `"Tie A"`))},
	})
	if err != nil || len(updated.RuleGroups) != 1 || updated.RuleGroups[0].ID != "legacy" ||
		!reflect.DeepEqual(updated.Rules, &updated.RuleGroups[0].Rules) {
		t.Fatalf("legacy patch = %+v, %v", updated, err)
	}
	assertCollectionBooks(t, fixture, viewer, legacy.ID, 101)
	if err := fixture.service.PutShelfBook(ctx, viewer, legacy.ID, 104, nil); err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, viewer, legacy.ID, 101, 104)
	empty := []RuleGroup{}
	if _, err := fixture.service.UpdateShelf(ctx, viewer, legacy.ID, ShelfPatch{
		RuleGroups: Optional[[]RuleGroup]{Set: true, Value: &empty}, RemoveRuleBooks: true,
	}); err != nil {
		t.Fatal(err)
	}
	assertCollectionBooks(t, fixture, viewer, legacy.ID, 104)
	if _, err := fixture.service.UpdateShelf(ctx, viewer, favoritesID(t, fixture.service, viewer), ShelfPatch{
		RuleGroups: Optional[[]RuleGroup]{Set: true, Value: &empty},
	}); !errors.Is(err, ErrConflict) {
		t.Fatalf("system shelf groups = %v, want conflict", err)
	}
}
