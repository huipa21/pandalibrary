package reading

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

const AutoFinishThreshold = 0.99

func autoStatus(current string, hasRow bool, percentage float64) (string, bool) {
	if !hasRow {
		current = "unread"
	}
	switch current {
	case "unread", "want_to_read", "reading", "rereading", "on_hold":
		if percentage >= AutoFinishThreshold {
			return "finished", true
		}
		if percentage > 0 && (current == "unread" || current == "want_to_read" || current == "on_hold") {
			return "reading", true
		}
	}
	return current, false
}

func updateAutoStatus(
	ctx context.Context, q *sqlc.Queries, tx *sql.Tx, viewer Viewer, bookID int64, percentage float64, moved bool, now int64,
) error {
	current, err := q.ReadingGetUserBook(ctx, sqlc.ReadingGetUserBookParams{
		UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
	})
	hasRow := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("get automatic reading status: %w", err)
	}
	if current.Status == "on_hold" && !moved {
		return nil
	}
	next, changed := autoStatus(current.Status, hasRow, percentage)
	if !changed || hasRow && now <= current.UpdatedAt {
		return nil
	}
	if current.Status == "on_hold" && next == "reading" {
		if current.ReadingCycle > 1 {
			next = "rereading"
		}
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
	if next == "finished" {
		return setLifecycleProgress(ctx, q, tx, viewer, bookID, now, 1)
	}
	return nil
}

func completedStatus(status string) bool {
	return status == "finished" || status == "skimmed"
}

// storedProgressPercentage keeps Read books at 100% while their position keeps syncing;
// only an explicit rereading status starts a new cycle with real progress.
func storedProgressPercentage(
	ctx context.Context, q *sqlc.Queries, viewer Viewer, bookID int64, percentage float64,
) (float64, error) {
	current, err := q.ReadingGetUserBook(ctx, sqlc.ReadingGetUserBookParams{
		UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
	})
	if errors.Is(err, sql.ErrNoRows) {
		return percentage, nil
	}
	if err != nil {
		return 0, fmt.Errorf("get reading status for progress: %w", err)
	}
	if completedStatus(current.Status) {
		return 1, nil
	}
	return percentage, nil
}

func progressMoved(previous sqlc.ReadingProgress, percentage float64, locator json.RawMessage) bool {
	if percentage <= 0 {
		return false
	}
	if percentage != previous.Percentage {
		return true
	}
	var before, after any
	_ = json.Unmarshal([]byte(previous.Locator.String), &before)
	_ = json.Unmarshal(locator, &after)
	return !reflect.DeepEqual(before, after)
}

func setLifecycleProgress(ctx context.Context, q *sqlc.Queries, tx *sql.Tx, viewer Viewer, bookID, now int64, percentage float64) error {
	clock, exists, err := readClock(ctx, func() (int64, error) {
		return q.ReadingGetProgressClock(ctx, sqlc.ReadingGetProgressClockParams{
			UserID: viewer.UserID, BookID: bookID,
		})
	})
	if err != nil {
		return err
	}
	if exists {
		now = max(now, clock+1)
	}
	rev, err := db.NextRev(ctx, tx)
	if err != nil {
		return err
	}
	if err := q.ReadingSetLifecycleProgress(ctx, sqlc.ReadingSetLifecycleProgressParams{
		UserID: viewer.UserID, BookID: bookID, Percentage: percentage, UpdatedAt: now, Rev: rev,
	}); err != nil {
		return fmt.Errorf("set lifecycle progress: %w", err)
	}
	return nil
}

func terminalStatus(status string) bool {
	return status == "finished" || status == "skimmed" || status == "abandoned"
}

func initialStatus(status string) bool {
	return status == "" || status == "unread" || status == "want_to_read"
}

func heldResumeStatus(current sqlc.UserBook) string {
	if current.Status != "on_hold" {
		return ""
	}
	if current.ReadingCycle > 1 {
		return "rereading"
	}
	return "reading"
}

func validateTransition(previous sqlc.UserBook, next string, progress sqlc.ReadingProgress, latestCycleEnd int64) string {
	if initialStatus(next) && next != previous.Status {
		if !initialStatus(previous.Status) || previous.StartedAt.Valid || previous.FinishedAt.Valid ||
			progress.Percentage > 0 || latestCycleEnd >= 0 {
			return "cannot return to unread or want_to_read after reading has started"
		}
	}
	if next == "on_hold" && previous.Status != "reading" && previous.Status != "rereading" && previous.Status != "on_hold" {
		return "on_hold is only available from reading or rereading"
	}
	if next == "rereading" && !terminalStatus(previous.Status) && previous.Status != "rereading" {
		if previous.Status != "on_hold" || previous.ReadingCycle <= 1 {
			return "rereading is only available after a terminal reading status"
		}
	}
	return ""
}

func archiveCycle(ctx context.Context, q *sqlc.Queries, viewer Viewer, previous sqlc.UserBook, progress sqlc.ReadingProgress, latest, now int64) (int64, error) {
	endedAt := now
	if previous.FinishedAt.Valid {
		endedAt = previous.FinishedAt.Int64
	}
	collision, err := q.ReadingCycleEndExists(ctx, sqlc.ReadingCycleEndExistsParams{
		UserID: viewer.UserID, BookID: previous.BookID, EndedAt: endedAt,
	})
	if err != nil {
		return 0, fmt.Errorf("check reading cycle timestamp: %w", err)
	}
	// Legacy timestamps can collide; advance only when needed to preserve each explicit cycle.
	if collision != 0 {
		endedAt = max(now, latest+1)
	}
	startedAt := endedAt
	if previous.StartedAt.Valid {
		startedAt = min(previous.StartedAt.Int64, endedAt)
	}
	err = q.ReadingArchiveCycle(ctx, sqlc.ReadingArchiveCycleParams{
		UserID: viewer.UserID, BookID: previous.BookID, StartedAt: startedAt, EndedAt: endedAt,
		Status: previous.Status, Percentage: progress.Percentage,
	})
	if err != nil {
		return 0, fmt.Errorf("archive reading cycle: %w", err)
	}
	return endedAt, nil
}
