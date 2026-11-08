package catalog

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestReviewsVisibility(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	for _, test := range visibilityCases() {
		for _, id := range []int64{101, 102, 103, 104, 999} {
			_, listErr := f.service.ListReviews(ctx, test.viewer, id, PageOptions{})
			review, saveErr := f.service.SaveMyReview(ctx, test.viewer, id, "review")
			deleteID := review.ID
			if deleteID == 0 {
				deleteID = 999
			}
			adminErr := f.service.DeleteReview(ctx, test.viewer, id, deleteID)
			deleteErr := f.service.DeleteMyReview(ctx, test.viewer, id)
			if !test.visible[id] {
				for _, err := range []error{listErr, saveErr, adminErr, deleteErr} {
					if !errors.Is(err, ErrNotFound) {
						t.Errorf("%s book %d: got %v, want not found", test.name, id, err)
					}
				}
			} else {
				if listErr != nil || saveErr != nil {
					t.Fatalf("%s book %d: list=%v save=%v", test.name, id, listErr, saveErr)
				}
				if test.viewer.IsAdmin {
					if adminErr != nil || !errors.Is(deleteErr, ErrNotFound) {
						t.Fatalf("admin deletes: %v, %v", adminErr, deleteErr)
					}
				} else if !errors.Is(adminErr, ErrForbidden) || deleteErr != nil {
					t.Fatalf("reader deletes: %v, %v", adminErr, deleteErr)
				}
			}
		}
	}
}

func TestReviewsValidationAndUpdate(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	for _, body := range []string{"", " \t\r\n ", strings.Repeat("x", 10001), strings.Repeat("界", 10001), "x\x00y"} {
		if _, err := f.service.SaveMyReview(ctx, viewer, 101, body); !errors.Is(err, ErrInvalid) {
			t.Fatalf("body length %d: %v", len(body), err)
		}
	}
	for _, body := range []string{strings.Repeat("x", 10000), strings.Repeat("界", 10000), strings.Repeat("😀", 10000)} {
		if _, err := f.service.SaveMyReview(ctx, viewer, 101, body); err != nil {
			t.Fatalf("valid body: %v", err)
		}
	}
	first, err := f.service.SaveMyReview(ctx, viewer, 101, "  first \n")
	if err != nil {
		t.Fatal(err)
	}
	f.service.now = func() time.Time { return time.UnixMilli(123456999) }
	second, err := f.service.SaveMyReview(ctx, viewer, 101, "second")
	if err != nil {
		t.Fatal(err)
	}
	if first.Body != "first" || first.Author.DisplayName != "reader" || !first.Mine ||
		first.ID != second.ID || !first.CreatedAt.Equal(second.CreatedAt) ||
		second.UpdatedAt.UnixMilli() != 123456999 {
		t.Fatalf("upsert: first=%+v second=%+v", first, second)
	}
	page, err := f.service.ListReviews(ctx, viewer, 101, PageOptions{})
	if err != nil || page.Mine == nil || page.Total != 1 || len(page.Items) != 0 ||
		!page.Mine.UpdatedAt.Equal(second.UpdatedAt) {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	for _, limit := range []int{-1, 51} {
		if _, err := f.service.ListReviews(ctx, viewer, 101, PageOptions{Limit: limit}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid limit %d: %v", limit, err)
		}
	}
}

func TestReviewsPagingAndAdminDelete(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 3, 1), (10, 4, 1);
		UPDATE users SET display_name = 'Display' WHERE id = 3`); err != nil {
		t.Fatal(err)
	}
	reviews := make([]Review, 0, 4)
	for id := int64(1); id <= 4; id++ {
		review, err := f.service.SaveMyReview(ctx, Viewer{UserID: id, IsAdmin: id == 1}, 101, "review")
		if err != nil {
			t.Fatal(err)
		}
		reviews = append(reviews, review)
	}
	viewer := Viewer{UserID: 2}
	cursor := ""
	for _, index := range []int{3, 2, 0} {
		page, err := f.service.ListReviews(ctx, viewer, 101, PageOptions{Limit: 1, Cursor: cursor})
		if err != nil || page.Total != 4 || page.Mine == nil || page.Mine.ID != reviews[1].ID ||
			len(page.Items) != 1 || page.Items[0].ID != reviews[index].ID || page.Items[0].Mine {
			t.Fatalf("page %+v: %v", page, err)
		}
		if index == 2 && page.Items[0].Author.DisplayName != "Display" {
			t.Fatal("display name was not used")
		}
		if index == 0 {
			if page.NextCursor != nil {
				t.Fatal("unexpected final cursor")
			}
			break
		}
		if page.NextCursor == nil {
			t.Fatal("missing cursor")
		}
		cursor = *page.NextCursor
	}
	for _, request := range []struct {
		viewer Viewer
		bookID int64
		token  string
	}{
		{viewer, 104, cursor}, {Viewer{UserID: 1, IsAdmin: true}, 101, cursor}, {viewer, 101, "invalid"},
	} {
		if _, err := f.service.ListReviews(ctx, request.viewer, request.bookID, PageOptions{Cursor: request.token}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("mismatched cursor: %v", err)
		}
	}
	admin := Viewer{UserID: 1, IsAdmin: true}
	if err := f.service.DeleteReview(ctx, admin, 104, reviews[2].ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-book deletion: %v", err)
	}
	if err := f.service.DeleteReview(ctx, admin, 101, reviews[2].ID); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeleteReview(ctx, admin, 101, reviews[2].ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing review: %v", err)
	}
}

func TestReviewsCascade(t *testing.T) {
	for _, target := range []string{"user", "book"} {
		t.Run(target, func(t *testing.T) {
			f := newCatalogFixture(t)
			ctx := context.Background()
			if _, err := f.service.SaveMyReview(ctx, Viewer{UserID: 2}, 101, "review"); err != nil {
				t.Fatal(err)
			}
			statement := `DELETE FROM users WHERE id = 2`
			if target == "book" {
				statement = `DELETE FROM books WHERE id = 101`
			}
			if _, err := f.db.Writer.ExecContext(ctx, statement); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := f.db.Reader.QueryRowContext(ctx, `SELECT count(*) FROM book_reviews`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("cascade count %d: %v", count, err)
			}
		})
	}
}

func TestReviewsPageLimitsAndUpdatedOrdering(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	for id := int64(5); id <= 55; id++ {
		if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
			VALUES (?, ?, 'x', 'user', 1, 1)`, id, fmt.Sprintf("reviewer-%d", id)); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO book_reviews (book_id, user_id, body, created_at, updated_at)
			VALUES (101, ?, 'review', 1, ?)`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	viewer := Viewer{UserID: 2}
	for _, test := range []struct {
		limit int
		want  int
	}{{0, 20}, {50, 50}} {
		page, err := f.service.ListReviews(ctx, viewer, 101, PageOptions{Limit: test.limit})
		if err != nil || len(page.Items) != test.want || page.Total != 51 || page.Mine != nil || page.NextCursor == nil {
			t.Fatalf("limit %d: page=%+v err=%v", test.limit, page, err)
		}
		if page.Items[0].Author.ID != 55 {
			t.Fatal("reviews not sorted by descending update time")
		}
		next, err := f.service.ListReviews(ctx, viewer, 101, PageOptions{Limit: test.limit, Cursor: *page.NextCursor})
		if err != nil || len(next.Items) == 0 || next.Items[0].Author.ID != 55-int64(test.want) {
			t.Fatalf("next page: %+v, %v", next, err)
		}
	}
	if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 5, 1)`); err != nil {
		t.Fatal(err)
	}
	updated, err := f.service.SaveMyReview(ctx, Viewer{UserID: 5}, 101, "updated")
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.service.ListReviews(ctx, viewer, 101, PageOptions{})
	if err != nil || len(page.Items) == 0 || page.Items[0].ID != updated.ID || page.Items[0].CreatedAt.UnixMilli() != 1 {
		t.Fatalf("updated ordering: %+v, %v", page, err)
	}
}
