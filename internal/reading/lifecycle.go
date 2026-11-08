package reading

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

const AutoFinishThreshold = 0.99

func autoStatus(current string, hasRow bool, percentage float64) (string, bool) {
	if !hasRow {
		current = "unread"
	}
	switch current {
	case "unread", "want_to_read", "reading", "rereading":
		if percentage >= AutoFinishThreshold {
			return "finished", true
		}
		if percentage > 0 && (current == "unread" || current == "want_to_read") {
			return "reading", true
		}
	}
	return current, false
}

func updateAutoStatus(
	ctx context.Context, q *sqlc.Queries, tx *sql.Tx, viewer Viewer, bookID int64, percentage float64, now int64,
) error {
	current, err := q.ReadingGetUserBook(ctx, sqlc.ReadingGetUserBookParams{
		UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
	})
	hasRow := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("get automatic reading status: %w", err)
	}
	next, changed := autoStatus(current.Status, hasRow, percentage)
	if !changed || hasRow && now <= current.UpdatedAt {
		return nil
	}
	rev, err := db.NextRev(ctx, tx)
	if err != nil {
		return err
	}
	finishedAt := sql.NullInt64{Int64: now, Valid: next == "finished"}
	_, err = q.ReadingAutoUpdateUserBookStatus(ctx, sqlc.ReadingAutoUpdateUserBookStatusParams{
		UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		Status: next, UpdatedAt: nullableIntInput(&now), FinishedAt: finishedAt, Rev: rev,
	})
	if err != nil {
		return fmt.Errorf("update automatic reading status: %w", err)
	}
	return nil
}

func resetProgress(ctx context.Context, q *sqlc.Queries, tx *sql.Tx, viewer Viewer, bookID, now int64) error {
	_, exists, err := readClock(ctx, func() (int64, error) {
		return q.ReadingGetProgressClock(ctx, sqlc.ReadingGetProgressClockParams{
			UserID: viewer.UserID, BookID: bookID,
		})
	})
	if err != nil || !exists {
		return err
	}
	rev, err := db.NextRev(ctx, tx)
	if err != nil {
		return err
	}
	if err := q.ReadingResetProgress(ctx, sqlc.ReadingResetProgressParams{
		UserID: viewer.UserID, BookID: bookID, UpdatedAt: now, Rev: rev,
	}); err != nil {
		return fmt.Errorf("reset re-reading progress: %w", err)
	}
	return nil
}
