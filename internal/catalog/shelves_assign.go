package catalog

import (
	"context"
	"database/sql"
	"fmt"

	"pandalibrary/internal/db/sqlc"
)

// assignableShelf applies the normal membership rules (visible, managed by the
// viewer) and additionally rejects other users' private shelves: bulk assignment
// never places books on a shelf that belongs to someone else, even for administrators.
func assignableShelf(ctx context.Context, queries *sqlc.Queries, viewer Viewer, shelfID int64) error {
	if shelfID < 1 {
		return invalid("shelf ID is invalid")
	}
	shelf, err := shelfForViewer(ctx, queries, viewer, shelfID)
	if err != nil {
		return err
	}
	if shelf.Kind == "private" && (!shelf.OwnerID.Valid || shelf.OwnerID.Int64 != viewer.UserID) {
		return ErrForbidden
	}
	if err := checkShelfManager(viewer, shelf); err != nil {
		return err
	}
	return nil
}

// CheckAssignableShelf reports whether viewer may add new books to shelfID. It returns
// ErrNotFound for missing or invisible shelves, ErrForbidden for shelves the viewer
// cannot write (including other users' private shelves).
// Favorites is an ordinary manual shelf owned by the viewer.
func (s *Service) CheckAssignableShelf(ctx context.Context, viewer Viewer, shelfID int64) error {
	if err := checkViewer(viewer); err != nil {
		return err
	}
	_, err := readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (struct{}, error) {
		return struct{}{}, assignableShelf(ctx, queries, viewer, shelfID)
	})
	return err
}

// AddAssignedBookTx appends bookID to shelfID inside tx after re-checking the rules of
// CheckAssignableShelf for viewer. Errors wrapping ErrNotFound, ErrForbidden, ErrConflict
// or ErrInvalid mean the shelf is no longer a valid target; other errors are failures.
func AddAssignedBookTx(ctx context.Context, tx *sql.Tx, viewer Viewer, shelfID, bookID int64, now int64) error {
	if err := checkViewer(viewer); err != nil {
		return err
	}
	if bookID < 1 {
		return invalid("book ID is invalid")
	}
	queries := sqlc.New(tx)
	if err := assignableShelf(ctx, queries, viewer, shelfID); err != nil {
		return err
	}
	if err := putShelfBook(ctx, queries, viewer, shelfID, bookID, nil, now); err != nil {
		return fmt.Errorf("add assigned book to shelf: %w", err)
	}
	return nil
}
