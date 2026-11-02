package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/db/sqlc"
)

var (
	ErrInvalid   = errors.New("invalid request")
	ErrNotFound  = errors.New("resource not found")
	ErrForbidden = errors.New("administrator access required")
	ErrConflict  = errors.New("conflict")
	ErrTooLarge  = errors.New("cover is too large")
)

// Service owns catalog authorization, database operations, and content access.
type Service struct {
	writer *sql.DB
	reader *sql.DB
	blobs  *blobstore.Store
	now    func() time.Time
}

// NewService constructs a catalog service using the existing database pools and blob store.
func NewService(writer, reader *sql.DB, blobs *blobstore.Store) (*Service, error) {
	if writer == nil || reader == nil || blobs == nil {
		return nil, errors.New("catalog requires writer and reader databases and a blob store")
	}
	return &Service{writer: writer, reader: reader, blobs: blobs, now: time.Now}, nil
}

func invalid(detail string) error {
	return fmt.Errorf("%w: %s", ErrInvalid, detail)
}

func conflict(detail string) error {
	return fmt.Errorf("%w: %s", ErrConflict, detail)
}

func checkViewer(viewer Viewer) error {
	if viewer.UserID < 1 {
		return invalid("viewer is invalid")
	}
	return nil
}

func checkAdmin(viewer Viewer) error {
	if err := checkViewer(viewer); err != nil {
		return err
	}
	if !viewer.IsAdmin {
		return ErrForbidden
	}
	return nil
}

func adminFlag(viewer Viewer) int64 {
	if viewer.IsAdmin {
		return 1
	}
	return 0
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func readSnapshot[T any](ctx context.Context, database *sql.DB, fn func(*sqlc.Queries) (T, error)) (value T, returnErr error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return value, fmt.Errorf("begin catalog read: %w", err)
	}
	defer func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			returnErr = errors.Join(returnErr, fmt.Errorf("roll back catalog read: %w", err))
		}
	}()
	value, err = fn(sqlc.New(tx))
	if err != nil {
		return value, err
	}
	if err := tx.Commit(); err != nil {
		return value, fmt.Errorf("commit catalog read: %w", err)
	}
	return value, nil
}

func utcMillis(value int64) time.Time {
	return time.UnixMilli(value).UTC()
}

func stringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func intPointer(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func floatPointer(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}
