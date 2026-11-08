package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

type ReviewAuthor struct {
	ID          int64  `json:"id"`
	DisplayName string `json:"display_name"`
}

type Review struct {
	ID        int64        `json:"id"`
	BookID    int64        `json:"book_id"`
	Author    ReviewAuthor `json:"author"`
	Body      string       `json:"body"`
	CreatedAt time.Time    `json:"created_at"`
	UpdatedAt time.Time    `json:"updated_at"`
	Mine      bool         `json:"mine"`
}

type ReviewPage struct {
	Mine       *Review  `json:"mine"`
	Items      []Review `json:"items"`
	NextCursor *string  `json:"next_cursor"`
	Total      int64    `json:"total"`
}

func reviewFromRow(row sqlc.ReviewMineRow, viewer Viewer) Review {
	return Review{
		ID: row.ID, BookID: row.BookID, Author: ReviewAuthor{ID: row.UserID, DisplayName: row.DisplayName},
		Body: row.Body, CreatedAt: utcMillis(row.CreatedAt), UpdatedAt: utcMillis(row.UpdatedAt),
		Mine: row.UserID == viewer.UserID,
	}
}

func checkReviewBook(ctx context.Context, queries *sqlc.Queries, viewer Viewer, bookID int64) error {
	if err := checkViewer(viewer); err != nil {
		return err
	}
	if bookID < 1 {
		return invalid("book ID is invalid")
	}
	_, err := visibleBook(ctx, queries, viewer, bookID)
	return err
}

func (s *Service) ListReviews(ctx context.Context, viewer Viewer, bookID int64, options PageOptions) (ReviewPage, error) {
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (ReviewPage, error) {
		if err := checkReviewBook(ctx, queries, viewer, bookID); err != nil {
			return ReviewPage{}, err
		}
		if options.Limit == 0 {
			options.Limit = 20
		}
		if options.Limit < 1 || options.Limit > 50 {
			return ReviewPage{}, invalid("limit must be between 1 and 50")
		}
		scope := fmt.Sprintf("%s:%d", viewerScope(viewer), bookID)
		limit, after, err := parsePage(options, "reviews", scope, "updated")
		if err != nil {
			return ReviewPage{}, err
		}
		page := ReviewPage{Items: []Review{}}
		mine, err := queries.ReviewMine(ctx, sqlc.ReviewMineParams{BookID: bookID, UserID: viewer.UserID})
		if err == nil {
			review := reviewFromRow(mine, viewer)
			page.Mine = &review
		} else if !errors.Is(err, sql.ErrNoRows) {
			return ReviewPage{}, fmt.Errorf("get own review: %w", err)
		}
		page.Total, err = queries.ReviewCount(ctx, bookID)
		if err != nil {
			return ReviewPage{}, fmt.Errorf("count reviews: %w", err)
		}
		rows, err := queries.ReviewList(ctx, sqlc.ReviewListParams{
			BookID: bookID, ViewerID: viewer.UserID, AfterID: after.ID, AfterTime: after.Time, PageSize: int64(limit + 1),
		})
		if err != nil {
			return ReviewPage{}, fmt.Errorf("list reviews: %w", err)
		}
		rows, page.NextCursor, err = paginate(rows, limit, func(row sqlc.ReviewListRow) cursor {
			return cursor{Version: 1, Kind: "reviews", Scope: scope, Sort: "updated", ID: row.ID, Time: row.UpdatedAt}
		})
		if err != nil {
			return ReviewPage{}, err
		}
		for _, row := range rows {
			page.Items = append(page.Items, reviewFromRow(sqlc.ReviewMineRow(row), viewer))
		}
		return page, nil
	})
}

func (s *Service) SaveMyReview(ctx context.Context, viewer Viewer, bookID int64, body string) (Review, error) {
	var result Review
	err := db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if err := checkReviewBook(ctx, queries, viewer, bookID); err != nil {
			return err
		}
		body = strings.TrimSpace(body)
		length := utf8.RuneCountInString(body)
		if !utf8.ValidString(body) || strings.ContainsRune(body, 0) || length < 1 || length > 10000 {
			return invalid("review body must contain 1 to 10000 characters and no NUL characters")
		}
		if err := queries.ReviewSave(ctx, sqlc.ReviewSaveParams{
			BookID: bookID, UserID: viewer.UserID, Body: body, Now: s.now().UnixMilli(),
		}); err != nil {
			return fmt.Errorf("save review: %w", err)
		}
		row, err := queries.ReviewMine(ctx, sqlc.ReviewMineParams{BookID: bookID, UserID: viewer.UserID})
		if err != nil {
			return fmt.Errorf("get saved review: %w", err)
		}
		result = reviewFromRow(row, viewer)
		return nil
	})
	return result, err
}

func (s *Service) DeleteMyReview(ctx context.Context, viewer Viewer, bookID int64) error {
	return s.deleteReview(ctx, viewer, bookID, 0)
}

func (s *Service) DeleteReview(ctx context.Context, viewer Viewer, bookID, reviewID int64) error {
	if reviewID < 1 {
		return invalid("review ID is invalid")
	}
	return s.deleteReview(ctx, viewer, bookID, reviewID)
}

func (s *Service) deleteReview(ctx context.Context, viewer Viewer, bookID, reviewID int64) error {
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if err := checkReviewBook(ctx, queries, viewer, bookID); err != nil {
			return err
		}
		var count int64
		var err error
		if reviewID == 0 {
			count, err = queries.ReviewDeleteMine(ctx, sqlc.ReviewDeleteMineParams{BookID: bookID, UserID: viewer.UserID})
		} else {
			if err := checkAdmin(viewer); err != nil {
				return err
			}
			count, err = queries.ReviewDelete(ctx, sqlc.ReviewDeleteParams{BookID: bookID, ID: reviewID})
		}
		if err != nil {
			return fmt.Errorf("delete review: %w", err)
		}
		if count == 0 {
			return ErrNotFound
		}
		return nil
	})
}
