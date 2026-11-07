package reading

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"pandalibrary/internal/db/sqlc"
)

// MaxBookStateIDs bounds one batched book-states lookup.
const MaxBookStateIDs = 100

// BookStateItem is the compact status and progress summary of one book for cover grids.
type BookStateItem struct {
	BookID     int64     `json:"book_id"`
	Status     string    `json:"status"`
	Percentage *float64  `json:"percentage"`
	BookFileID *int64    `json:"book_file_id"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// ListBookStates returns the viewer's status and progress for the requested visible books.
// Books without a user_books or reading_progress row are omitted.
func (s *Service) ListBookStates(ctx context.Context, viewer Viewer, bookIDs []int64) ([]BookStateItem, error) {
	if err := checkViewer(viewer); err != nil {
		return nil, err
	}
	ids, err := normalizeBookStateIDs(bookIDs)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(ids)
	if err != nil {
		return nil, fmt.Errorf("encode book state IDs: %w", err)
	}
	rows, err := sqlc.New(s.reader).ReadingListBookStates(ctx, sqlc.ReadingListBookStatesParams{
		UserID: viewer.UserID, BookIdsJson: string(encoded), IsAdmin: adminFlag(viewer),
	})
	if err != nil {
		return nil, fmt.Errorf("list book states: %w", err)
	}
	items := make([]BookStateItem, 0, len(rows))
	for _, row := range rows {
		item := BookStateItem{BookID: row.BookID, Status: "unread"}
		var updatedAt int64
		if row.Status.Valid {
			item.Status = row.Status.String
			updatedAt = row.UserBookUpdatedAt.Int64
		}
		if row.Percentage.Valid {
			percentage := row.Percentage.Float64
			item.Percentage = &percentage
			item.BookFileID = nullableInt(row.BookFileID)
			updatedAt = max(updatedAt, row.ProgressUpdatedAt.Int64)
		}
		item.UpdatedAt = timestamp(updatedAt)
		items = append(items, item)
	}
	return items, nil
}

func normalizeBookStateIDs(bookIDs []int64) ([]int64, error) {
	if len(bookIDs) == 0 {
		return nil, fmt.Errorf("%w: at least one book ID is required", ErrInvalid)
	}
	if len(bookIDs) > MaxBookStateIDs {
		return nil, fmt.Errorf("%w: at most %d book IDs are allowed", ErrInvalid, MaxBookStateIDs)
	}
	seen := make(map[int64]struct{}, len(bookIDs))
	ids := make([]int64, 0, len(bookIDs))
	for _, id := range bookIDs {
		if id < 1 {
			return nil, fmt.Errorf("%w: book IDs must be positive integers", ErrInvalid)
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, nil
}
