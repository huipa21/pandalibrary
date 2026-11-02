package catalog

import (
	"context"
	"errors"
	"testing"
)

func TestLibraryCRUDAndDefaultGuard(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	reader := Viewer{UserID: 2}
	library, err := fixture.service.CreateLibrary(ctx, admin, " Comics ", "comics")
	if err != nil || library.Name != "Comics" || library.Slug != "comics" {
		t.Fatalf("create library = %+v, %v", library, err)
	}
	for _, test := range []struct {
		name string
		slug string
		want error
	}{
		{"comics", "other", ErrConflict},
		{"Other", "comics", ErrConflict},
		{"", "valid", ErrInvalid},
		{"Other", "../escape", ErrInvalid},
		{"Other", "UPPER", ErrInvalid},
	} {
		if _, err := fixture.service.CreateLibrary(ctx, admin, test.name, test.slug); !errors.Is(err, test.want) {
			t.Errorf("create %q / %q error = %v, want %v", test.name, test.slug, err, test.want)
		}
	}
	if _, err := fixture.service.CreateLibrary(ctx, reader, "Forbidden", "forbidden"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-admin create = %v", err)
	}
	renamed := "Graphic Novels"
	updated, err := fixture.service.UpdateLibrary(ctx, admin, library.ID, LibraryPatch{Name: Optional[string]{Set: true, Value: &renamed}})
	if err != nil || updated.Name != renamed || updated.Slug != "comics" {
		t.Fatalf("update library = %+v, %v", updated, err)
	}
	duplicate := "main"
	if _, err := fixture.service.UpdateLibrary(ctx, admin, library.ID, LibraryPatch{Slug: Optional[string]{Set: true, Value: &duplicate}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate slug = %v", err)
	}
	if _, err := fixture.service.UpdateLibrary(ctx, admin, library.ID, LibraryPatch{Name: Optional[string]{Set: true}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("null name = %v", err)
	}
	if err := fixture.service.DeleteLibrary(ctx, admin, 10); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete nonempty library = %v", err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO server_settings (key, value, updated_at) VALUES ('default_library_id', '30', 1)`); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.DeleteLibrary(ctx, admin, 30); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete default library = %v", err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `UPDATE server_settings SET value = 'null' WHERE key = 'default_library_id'`); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.DeleteLibrary(ctx, admin, 30); err != nil {
		t.Fatalf("delete empty library = %v", err)
	}
	if err := fixture.service.DeleteLibrary(ctx, admin, library.ID); err != nil {
		t.Fatalf("delete created library = %v", err)
	}
	if err := fixture.service.DeleteLibrary(ctx, admin, library.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete missing library = %v", err)
	}
}

func TestAccessAndHideChangesAffectVisibility(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	reader := Viewer{UserID: 2}
	other := Viewer{UserID: 3}
	if _, err := fixture.service.GetBook(ctx, reader, 103); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reader sees private book before grant: %v", err)
	}
	for range 2 {
		if err := fixture.service.SetAccess(ctx, admin, 20, 2, true); err != nil {
			t.Fatalf("grant access: %v", err)
		}
	}
	if _, err := fixture.service.GetBook(ctx, reader, 103); err != nil {
		t.Fatalf("reader cannot see granted book: %v", err)
	}
	for range 2 {
		if err := fixture.service.SetHidden(ctx, admin, 2, 103, true); err != nil {
			t.Fatalf("hide book: %v", err)
		}
	}
	if _, err := fixture.service.GetBook(ctx, reader, 103); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reader sees hidden book: %v", err)
	}
	hidden, err := fixture.service.ListHidden(ctx, admin, 2, PageOptions{})
	if err != nil || len(hidden.Items) != 2 || hidden.Items[1].HiddenBy == nil || *hidden.Items[1].HiddenBy != 1 {
		t.Fatalf("hide configuration = %+v, %v", hidden, err)
	}
	if _, err := fixture.service.GetBook(ctx, other, 103); err != nil {
		t.Fatalf("another user's hide affected visibility: %v", err)
	}
	for range 2 {
		if err := fixture.service.SetHidden(ctx, admin, 2, 103, false); err != nil {
			t.Fatalf("unhide book: %v", err)
		}
		if err := fixture.service.SetAccess(ctx, admin, 20, 2, false); err != nil {
			t.Fatalf("revoke access: %v", err)
		}
	}
	if _, err := fixture.service.GetBook(ctx, reader, 103); !errors.Is(err, ErrNotFound) {
		t.Fatalf("reader sees revoked book: %v", err)
	}
	if _, err := fixture.service.GetBook(ctx, admin, 103); !errors.Is(err, ErrNotFound) {
		t.Fatalf("admin bypassed own hide list: %v", err)
	}
	if err := fixture.service.DeleteBook(ctx, admin, 103); !errors.Is(err, ErrNotFound) {
		t.Fatalf("admin deleted own hidden book: %v", err)
	}
	title := "Forbidden"
	if _, err := fixture.service.UpdateBook(ctx, admin, 103, BookPatch{Title: Optional[string]{Set: true, Value: &title}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("admin edited own hidden book: %v", err)
	}
	adminHidden, err := fixture.service.ListHidden(ctx, admin, 1, PageOptions{})
	if err != nil || len(adminHidden.Items) != 1 || adminHidden.Items[0].BookID != 103 {
		t.Fatalf("admin hide configuration = %+v, %v", adminHidden, err)
	}
	if err := fixture.service.SetHidden(ctx, admin, 1, 103, false); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.GetBook(ctx, admin, 103); err != nil {
		t.Fatalf("admin cannot see unhidden book: %v", err)
	}
	for _, operation := range []func() error{
		func() error { return fixture.service.SetAccess(ctx, reader, 10, 3, true) },
		func() error { return fixture.service.SetHidden(ctx, reader, 3, 101, true) },
	} {
		if err := operation(); !errors.Is(err, ErrForbidden) {
			t.Fatalf("non-admin operation = %v", err)
		}
	}
	for _, operation := range []func() error{
		func() error { return fixture.service.SetAccess(ctx, admin, 999, 2, true) },
		func() error { return fixture.service.SetAccess(ctx, admin, 10, 999, true) },
		func() error { return fixture.service.SetHidden(ctx, admin, 999, 101, true) },
		func() error { return fixture.service.SetHidden(ctx, admin, 2, 999, false) },
	} {
		if err := operation(); !errors.Is(err, ErrNotFound) {
			t.Fatalf("missing resource operation = %v", err)
		}
	}
	if err := fixture.service.SetAccess(ctx, admin, 10, 1, true); !errors.Is(err, ErrInvalid) {
		t.Fatalf("grant to admin = %v", err)
	}
}
