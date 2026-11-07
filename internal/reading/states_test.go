package reading

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestListBookStatesVisibilityOwnershipAndShape(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	statements := []string{
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(104, 10, 'Progress only', 'progress only', 1, 1),
			(105, 10, 'Status only', 'status only', 1, 1),
			(106, 10, 'Other user only', 'other user only', 1, 1),
			(107, 10, 'Untouched', 'untouched', 1, 1)`,
		`INSERT INTO user_books (user_id, book_id, status, updated_at, rev) VALUES
			(2, 101, 'reading', 5000, 1),
			(2, 102, 'reading', 5000, 2),
			(2, 103, 'finished', 5000, 3),
			(2, 105, 'finished', 4000, 4),
			(3, 101, 'abandoned', 9000, 5),
			(3, 106, 'want_to_read', 9000, 6),
			(1, 103, 'want_to_read', 6000, 7)`,
		`INSERT INTO reading_progress (user_id, book_id, book_file_id, source, percentage, updated_at, rev) VALUES
			(2, 101, 201, 'web', 0.42, 7000, 8),
			(2, 104, NULL, 'koreader', 0.1, 3000, 9),
			(3, 101, 201, 'web', 0.9, 9000, 10),
			(3, 106, NULL, 'web', 0.5, 9000, 11)`,
	}
	for _, statement := range statements {
		if _, err := fixture.db.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed book states: %v", err)
		}
	}

	items, err := fixture.service.ListBookStates(ctx, Viewer{UserID: 2},
		[]int64{107, 106, 105, 104, 103, 102, 101, 101, 999})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("items = %+v, want books 101, 104 and 105", items)
	}
	first := items[0]
	if first.BookID != 101 || first.Status != "reading" || first.Percentage == nil || *first.Percentage != 0.42 ||
		first.BookFileID == nil || *first.BookFileID != 201 || !first.UpdatedAt.Equal(time.UnixMilli(7000)) ||
		first.UpdatedAt.Location() != time.UTC {
		t.Errorf("status and progress row = %+v", first)
	}
	progressOnly := items[1]
	if progressOnly.BookID != 104 || progressOnly.Status != "unread" || progressOnly.Percentage == nil ||
		*progressOnly.Percentage != 0.1 || progressOnly.BookFileID != nil ||
		!progressOnly.UpdatedAt.Equal(time.UnixMilli(3000)) {
		t.Errorf("progress-only row = %+v", progressOnly)
	}
	statusOnly := items[2]
	if statusOnly.BookID != 105 || statusOnly.Status != "finished" || statusOnly.Percentage != nil ||
		statusOnly.BookFileID != nil || !statusOnly.UpdatedAt.Equal(time.UnixMilli(4000)) {
		t.Errorf("status-only row = %+v", statusOnly)
	}

	admin, err := fixture.service.ListBookStates(ctx, Viewer{UserID: 1, IsAdmin: true}, []int64{101, 103})
	if err != nil || len(admin) != 1 || admin[0].BookID != 103 || admin[0].Status != "want_to_read" {
		t.Errorf("admin states = %+v, %v", admin, err)
	}
	other, err := fixture.service.ListBookStates(ctx, Viewer{UserID: 3}, []int64{101, 106})
	if err != nil || len(other) != 0 {
		t.Errorf("states in an inaccessible library = %+v, %v", other, err)
	}
}

func TestListBookStatesLimitsAndDedupe(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	if _, err := fixture.db.Writer.ExecContext(ctx,
		`INSERT INTO user_books (user_id, book_id, status, updated_at, rev) VALUES (2, 101, 'reading', 1000, 1)`,
	); err != nil {
		t.Fatal(err)
	}
	atLimit := make([]int64, MaxBookStateIDs)
	for i := range atLimit {
		atLimit[i] = 101
	}
	items, err := fixture.service.ListBookStates(ctx, Viewer{UserID: 2}, atLimit)
	if err != nil || len(items) != 1 || items[0].BookID != 101 {
		t.Fatalf("deduplicated states = %+v, %v", items, err)
	}
	for name, ids := range map[string][]int64{
		"empty":    nil,
		"too many": append(atLimit, 101),
		"zero":     {101, 0},
		"negative": {-5},
	} {
		if _, err := fixture.service.ListBookStates(ctx, Viewer{UserID: 2}, ids); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: error = %v, want invalid", name, err)
		}
	}
	if _, err := fixture.service.ListBookStates(ctx, Viewer{}, []int64{101}); !errors.Is(err, ErrInvalid) {
		t.Errorf("anonymous viewer error = %v, want invalid", err)
	}
}
