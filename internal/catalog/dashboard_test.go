package catalog

import (
	"context"
	"fmt"
	"reflect"
	"testing"
)

func dashboardBookIDs(t *testing.T, service *Service, viewer Viewer, section string, limit int) []int64 {
	t.Helper()
	var result []int64
	options := PageOptions{Limit: limit}
	for pageNumber := 0; ; pageNumber++ {
		if pageNumber > 200 {
			t.Fatal("dashboard pagination did not terminate")
		}
		page, err := service.ListDashboardBooks(context.Background(), viewer, section, options)
		if err != nil {
			t.Fatal(err)
		}
		for _, book := range page.Items {
			result = append(result, book.ID)
		}
		if page.NextCursor == nil {
			return result
		}
		options.Cursor = *page.NextCursor
	}
}

func setProgress(t *testing.T, fixture catalogFixture, userID, bookID int64, percentage float64) {
	t.Helper()
	ctx := context.Background()
	_, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO reading_progress (user_id, book_id, source, percentage, updated_at, rev)
		VALUES (?, ?, 'web', ?, 123456789, 1)
		ON CONFLICT(user_id, book_id) DO UPDATE SET percentage = excluded.percentage, updated_at = excluded.updated_at
	`, userID, bookID, percentage)
	if err != nil {
		t.Fatal(err)
	}
}

func setUserBookStatus(t *testing.T, fixture catalogFixture, userID, bookID int64, status string) {
	t.Helper()
	ctx := context.Background()
	_, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO user_books (user_id, book_id, status, updated_at, rev)
		VALUES (?, ?, ?, 123456789, 1)
		ON CONFLICT(user_id, book_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
	`, userID, bookID, status)
	if err != nil {
		t.Fatal(err)
	}
}

func hideBook(t *testing.T, fixture catalogFixture, userID, bookID, hiddenByID int64) {
	t.Helper()
	ctx := context.Background()
	_, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT OR IGNORE INTO book_hidden (user_id, book_id, hidden_by, created_at)
		VALUES (?, ?, ?, 123456789)
	`, userID, bookID, hiddenByID)
	if err != nil {
		t.Fatal(err)
	}
}

func TestDashboardContinueReading(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	reader1, reader2 := Viewer{UserID: 2}, Viewer{UserID: 3}

	// Create a new library for this test
	_, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO libraries (id, name, slug, created_at, updated_at)
		VALUES (100, 'Test Library', 'testlib', 123456789, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO library_access (library_id, user_id, granted_at)
		VALUES (100, 2, 123456789), (100, 3, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}

	// Create books in the test library
	for i := 1; i <= 3; i++ {
		_, err := fixture.db.Writer.ExecContext(ctx, `
			INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
			VALUES (?, 100, ?, ?, 123456789, 123456789)
		`, 200+i, fmt.Sprintf("Book %d", i), fmt.Sprintf("book %d", i))
		if err != nil {
			t.Fatal(err)
		}
	}

	// Set progress for reader1
	setProgress(t, fixture, reader1.UserID, 201, 0.3)
	setProgress(t, fixture, reader1.UserID, 202, 0.7)
	// Set progress for reader2
	setProgress(t, fixture, reader2.UserID, 203, 0.5)

	// Test reader1 sees books 201 and 202
	ids := dashboardBookIDs(t, fixture.service, reader1, "continue_reading", 50)
	if len(ids) != 2 {
		t.Errorf("reader1 continue reading count = %d, want 2", len(ids))
	}

	// Test reader2 sees only book 203
	ids = dashboardBookIDs(t, fixture.service, reader2, "continue_reading", 50)
	if len(ids) != 1 || ids[0] != 203 {
		t.Errorf("reader2 continue reading = %v, want [203]", ids)
	}

	// Test pagination
	page1, err := fixture.service.ListDashboardBooks(ctx, reader1, "continue_reading", PageOptions{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page1.Items) != 1 {
		t.Errorf("page 1 size = %d, want 1", len(page1.Items))
	}
	if page1.NextCursor == nil {
		t.Fatal("expected next cursor for page 1")
	}

	page2, err := fixture.service.ListDashboardBooks(ctx, reader1, "continue_reading", PageOptions{Limit: 1, Cursor: *page1.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(page2.Items) != 1 {
		t.Errorf("page 2 size = %d, want 1", len(page2.Items))
	}
	if page2.NextCursor != nil {
		t.Fatal("did not expect next cursor for final page")
	}
	if page1.Items[0].ID == page2.Items[0].ID {
		t.Fatal("page 1 and page 2 have same book")
	}
}

func TestDashboardRecentlyAdded(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	reader := Viewer{UserID: 2}

	// The reader has access to library 10 with books from the fixture.
	// Query recently_added for library 10 - should include those fixture books
	// This tests that visibility filtering works correctly.
	ids := dashboardBookIDs(t, fixture.service, reader, "recently_added", 50)

	// Should see at least the recently added books from the default fixture
	if len(ids) < 2 {
		t.Errorf("recently_added count = %d, want at least 2", len(ids))
	}

	// All should be accessible by the reader (library 10 or others they have access to)
	for _, id := range ids {
		book, err := fixture.service.GetBook(ctx, reader, id)
		if err != nil {
			t.Errorf("reader cannot access book %d: %v", id, err)
		}
		if book.ID != id {
			t.Errorf("unexpected book: %v", book.ID)
		}
	}
}

func TestDashboardReadBooks(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	reader1, reader2 := Viewer{UserID: 2}, Viewer{UserID: 3}

	// Create test library
	_, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO libraries (id, name, slug, created_at, updated_at)
		VALUES (102, 'Test Lib 3', 'testlib3', 123456789, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO library_access (library_id, user_id, granted_at)
		VALUES (102, 2, 123456789), (102, 3, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}

	// Create books
	for i := 1; i <= 3; i++ {
		_, err := fixture.db.Writer.ExecContext(ctx, `
			INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
			VALUES (?, 102, ?, ?, 123456789, 123456789)
		`, 220+i, fmt.Sprintf("Book %d", i), fmt.Sprintf("book %d", i))
		if err != nil {
			t.Fatal(err)
		}
	}

	// Mark as finished
	setUserBookStatus(t, fixture, reader1.UserID, 221, "finished")
	setUserBookStatus(t, fixture, reader1.UserID, 222, "finished")
	setUserBookStatus(t, fixture, reader2.UserID, 223, "finished")

	// Test reader1
	ids := dashboardBookIDs(t, fixture.service, reader1, "read", 50)
	if len(ids) != 2 {
		t.Errorf("reader1 read count = %d, want 2", len(ids))
	}

	// Test reader2
	ids = dashboardBookIDs(t, fixture.service, reader2, "read", 50)
	if len(ids) != 1 || ids[0] != 223 {
		t.Errorf("reader2 read = %v, want [223]", ids)
	}
}

func TestDashboardExtendedReadingStatuses(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	viewer := Viewer{UserID: 2}
	for _, statement := range []string{
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (150, 'Status', 'status', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (150, 2, 1)`,
	} {
		if _, err := fixture.db.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	statuses := []string{"unread", "want_to_read", "reading", "on_hold", "rereading", "finished", "skimmed", "abandoned"}
	for i := 0; i <= len(statuses); i++ {
		id := int64(3001 + i)
		if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO books
			(id, library_id, title, sort_title, created_at, updated_at) VALUES (?, 150, 'Status', 'status', 1, 1)`, id); err != nil {
			t.Fatal(err)
		}
		setProgress(t, fixture, viewer.UserID, id, 0.5)
		if i < len(statuses) {
			setUserBookStatus(t, fixture, viewer.UserID, id, statuses[i])
		}
	}
	for section, want := range map[string][]int64{
		"continue_reading": {3009, 3005, 3004, 3003, 3002, 3001},
		"read":             {3007, 3006},
	} {
		if got := dashboardBookIDs(t, fixture.service, viewer, section, 1); !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", section, got, want)
		}
	}
}

func TestDashboardUnread(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	reader := Viewer{UserID: 2}

	// Create test library
	_, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO libraries (id, name, slug, created_at, updated_at)
		VALUES (103, 'Test Lib 4', 'testlib4', 123456789, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO library_access (library_id, user_id, granted_at)
		VALUES (103, 2, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}

	// Create books - use unique IDs to avoid conflicts
	for i := 1; i <= 3; i++ {
		_, err := fixture.db.Writer.ExecContext(ctx, `
			INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
			VALUES (?, 103, ?, ?, 123456789, 123456789)
		`, 6230+i, fmt.Sprintf("Book %c", 'A'+i-1), fmt.Sprintf("book %c", 'a'+i-1))
		if err != nil {
			t.Fatal(err)
		}
	}

	// Mark some with other statuses
	setUserBookStatus(t, fixture, reader.UserID, 6232, "reading")
	setUserBookStatus(t, fixture, reader.UserID, 6233, "want_to_read")
	// Explicitly mark as unread
	setUserBookStatus(t, fixture, reader.UserID, 6231, "unread")

	// Should see book 6231 (explicitly unread)
	ids := dashboardBookIDs(t, fixture.service, reader, "unread", 50)
	if len(ids) < 1 || ids[0] != 6231 {
		t.Errorf("book 6231 not in unread results: %v", ids)
	}

	// Verify that books with other statuses are excluded
	for _, id := range ids {
		if id == 6232 || id == 6233 {
			t.Errorf("book %d should not be in unread results", id)
		}
	}
}

func TestDashboardWantToRead(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	reader1, reader2 := Viewer{UserID: 2}, Viewer{UserID: 3}

	// Create test library
	_, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO libraries (id, name, slug, created_at, updated_at)
		VALUES (104, 'Test Lib 5', 'testlib5', 123456789, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO library_access (library_id, user_id, granted_at)
		VALUES (104, 2, 123456789), (104, 3, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}

	// Create books
	for i := 1; i <= 3; i++ {
		_, err := fixture.db.Writer.ExecContext(ctx, `
			INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
			VALUES (?, 104, ?, ?, 123456789, 123456789)
		`, 240+i, fmt.Sprintf("Book %d", i), fmt.Sprintf("book %d", i))
		if err != nil {
			t.Fatal(err)
		}
	}

	// Set want_to_read status
	setUserBookStatus(t, fixture, reader1.UserID, 241, "want_to_read")
	setUserBookStatus(t, fixture, reader1.UserID, 242, "want_to_read")
	setUserBookStatus(t, fixture, reader2.UserID, 243, "want_to_read")

	// Test reader1
	ids := dashboardBookIDs(t, fixture.service, reader1, "want_to_read", 50)
	if len(ids) != 2 {
		t.Errorf("reader1 want_to_read count = %d, want 2", len(ids))
	}

	// Test reader2
	ids = dashboardBookIDs(t, fixture.service, reader2, "want_to_read", 50)
	if len(ids) != 1 || ids[0] != 243 {
		t.Errorf("reader2 want_to_read = %v, want [243]", ids)
	}
}

func TestDashboardHiddenBooks(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	reader, admin := Viewer{UserID: 2}, Viewer{UserID: 1, IsAdmin: true}

	// Create test library
	_, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO libraries (id, name, slug, created_at, updated_at)
		VALUES (105, 'Test Lib 6', 'testlib6', 123456789, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO library_access (library_id, user_id, granted_at)
		VALUES (105, 2, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}

	// Create books
	_, err = fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		VALUES (250, 105, 'Book 1', 'book 1', 123456789, 123456789),
		       (251, 105, 'Book 2', 'book 2', 123456789, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}

	// Hide book 250 for reader
	hideBook(t, fixture, reader.UserID, 250, admin.UserID)

	// Add progress to both
	setProgress(t, fixture, reader.UserID, 250, 0.5)
	setProgress(t, fixture, reader.UserID, 251, 0.5)

	// Should only see book 251
	ids := dashboardBookIDs(t, fixture.service, reader, "continue_reading", 50)
	if len(ids) != 1 || ids[0] != 251 {
		t.Errorf("hidden books test = %v, want [251]", ids)
	}
}

func TestDashboardLibraryAccess(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	reader1, reader2 := Viewer{UserID: 2}, Viewer{UserID: 3}

	// Create two libraries
	_, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO libraries (id, name, slug, created_at, updated_at)
		VALUES (106, 'Lib A', 'liba', 123456789, 123456789),
		       (107, 'Lib B', 'libb', 123456789, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO library_access (library_id, user_id, granted_at)
		VALUES (106, 2, 123456789), (107, 3, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}

	// Create books in each library
	_, err = fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		VALUES (260, 106, 'Book A', 'book a', 123456789, 123456789),
		       (261, 107, 'Book B', 'book b', 123456789, 123456789)
	`)
	if err != nil {
		t.Fatal(err)
	}

	// Add progress
	setProgress(t, fixture, reader1.UserID, 260, 0.5)
	setProgress(t, fixture, reader2.UserID, 261, 0.5)

	// Test reader1 only sees book 260
	ids := dashboardBookIDs(t, fixture.service, reader1, "continue_reading", 50)
	if len(ids) != 1 || ids[0] != 260 {
		t.Errorf("reader1 access = %v, want [260]", ids)
	}

	// Test reader2 only sees book 261
	ids = dashboardBookIDs(t, fixture.service, reader2, "continue_reading", 50)
	if len(ids) != 1 || ids[0] != 261 {
		t.Errorf("reader2 access = %v, want [261]", ids)
	}
}

func TestDashboardInvalidSection(t *testing.T) {
	fixture := newCatalogFixture(t)
	reader := Viewer{UserID: 2}

	_, err := fixture.service.ListDashboardBooks(context.Background(), reader, "invalid_section", PageOptions{})
	if err == nil {
		t.Fatal("expected error for invalid section")
	}
}

func TestDashboardLimitValidation(t *testing.T) {
	fixture := newCatalogFixture(t)
	reader := Viewer{UserID: 2}

	// Test limit > 100
	_, err := fixture.service.ListDashboardBooks(context.Background(), reader, "continue_reading", PageOptions{Limit: 101})
	if err == nil {
		t.Fatal("expected error for limit > 100")
	}

	// Test with default limit (should work)
	_, err = fixture.service.ListDashboardBooks(context.Background(), reader, "continue_reading", PageOptions{})
	if err != nil {
		t.Fatalf("default limit should work: %v", err)
	}
}

func TestDashboardInvalidCursor(t *testing.T) {
	fixture := newCatalogFixture(t)
	reader := Viewer{UserID: 2}

	_, err := fixture.service.ListDashboardBooks(context.Background(), reader, "continue_reading", PageOptions{Cursor: "invalid"})
	if err == nil {
		t.Fatal("expected error for malformed cursor")
	}
}

func TestDashboardKeysetsOrderingAndLiveChanges(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	viewer := Viewer{UserID: 4}
	statements := []string{
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (200, 'Dashboard', 'dashboard', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (200, 4, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
				(301, 200, 'alpha', 'alpha', 300, 1), (302, 200, 'Alpha', 'alpha', 300, 1),
				(303, 200, 'Beta', 'beta', 200, 1), (304, 200, 'Gamma', 'gamma', 100, 1),
				(305, 200, 'Hidden', 'hidden', 400, 1), (306, 200, 'Zero', 'zero', 100, 1),
				(307, 200, 'Complete', 'complete', 100, 1), (308, 200, 'Want', 'want', 100, 1),
				(309, 200, 'Want too', 'want too', 100, 1), (310, 200, 'Read fallback', 'read fallback', 100, 1)`,
		`INSERT INTO reading_progress (user_id, book_id, source, percentage, updated_at, rev) VALUES
				(4, 301, 'web', .4, 50, 1), (4, 302, 'web', .5, 50, 1), (4, 303, 'web', .3, 70, 1),
				(4, 304, 'web', .8, 90, 1), (4, 305, 'web', .3, 100, 1),
				(4, 306, 'web', 0, 100, 1), (4, 307, 'web', 1, 100, 1),
				(2, 308, 'web', .5, 200, 1)`,
		`INSERT INTO user_books (user_id, book_id, status, finished_at, updated_at, rev) VALUES
				(4, 301, 'unread', NULL, 1, 1), (4, 302, 'reading', NULL, 1, 1),
				(4, 303, 'abandoned', NULL, 1, 1), (4, 304, 'finished', 120, 10, 1),
				(4, 308, 'want_to_read', NULL, 80, 1), (4, 309, 'want_to_read', NULL, 80, 1),
				(4, 310, 'finished', NULL, 130, 1)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (4, 305, 1, 1)`,
	}
	for _, statement := range statements {
		if _, err := fixture.db.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	for section, want := range map[string][]int64{
		"continue_reading": {302, 301},
		"recently_added":   {302, 301, 303, 310, 309, 308, 307, 306, 304},
		"read":             {310, 304},
		"unread":           {301, 307, 306},
		"want_to_read":     {309, 308},
	} {
		if got := dashboardBookIDs(t, fixture.service, viewer, section, 1); !reflect.DeepEqual(got, want) {
			t.Errorf("%s = %v, want %v", section, got, want)
		}
	}

	first, err := fixture.service.ListDashboardBooks(ctx, viewer, "continue_reading", PageOptions{Limit: 1})
	if err != nil || first.NextCursor == nil || first.Items[0].ID != 302 {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	for _, other := range []struct {
		viewer  Viewer
		section string
	}{
		{Viewer{UserID: 2}, "continue_reading"},
		{viewer, "recently_added"},
	} {
		if _, err := fixture.service.ListDashboardBooks(ctx, other.viewer, other.section, PageOptions{Limit: 1, Cursor: *first.NextCursor}); err == nil {
			t.Error("cursor accepted for a different viewer or section")
		}
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `UPDATE reading_progress SET updated_at = 200 WHERE user_id = 4 AND book_id = 302`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (4, 302, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	second, err := fixture.service.ListDashboardBooks(ctx, viewer, "continue_reading", PageOptions{Limit: 1, Cursor: *first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].ID != 301 || second.NextCursor != nil {
		t.Fatalf("page after anchor changed = %+v, %v", second, err)
	}
}

func TestDashboardDefaultPageSize(t *testing.T) {
	ctx := context.Background()
	fixture := newCatalogFixture(t)
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO library_access (library_id, user_id, granted_at) VALUES (30, 4, 1)`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 21; i++ {
		if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO books (library_id, title, sort_title, created_at, updated_at) VALUES (30, ?, ?, 1, 1)`, fmt.Sprintf("Book %02d", i), fmt.Sprintf("book %02d", i)); err != nil {
			t.Fatal(err)
		}
	}
	page, err := fixture.service.ListDashboardBooks(ctx, Viewer{UserID: 4}, "recently_added", PageOptions{})
	if err != nil || len(page.Items) != 20 || page.NextCursor == nil {
		t.Fatalf("default page = %+v, %v", page, err)
	}
}
