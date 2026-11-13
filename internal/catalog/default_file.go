package catalog

import (
	"context"
	"database/sql"
	"fmt"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

// SetDefaultFile marks one of a visible book's files as its default, or clears
// the default when fileID is nil.
func (s *Service) SetDefaultFile(ctx context.Context, viewer Viewer, bookID int64, fileID *int64) (Book, error) {
	if err := checkAdmin(viewer); err != nil {
		return Book{}, err
	}
	if bookID < 1 || (fileID != nil && *fileID < 1) {
		return Book{}, invalid("book or file ID is invalid")
	}
	err := db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		if _, err := visibleBook(ctx, sqlc.New(tx), viewer, bookID); err != nil {
			return err
		}
		if fileID != nil {
			var exists bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM book_files WHERE id = ? AND book_id = ?)`,
				*fileID, bookID).Scan(&exists); err != nil {
				return fmt.Errorf("check book file: %w", err)
			}
			if !exists {
				return ErrNotFound
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE book_files SET is_default = 0 WHERE book_id = ? AND is_default = 1`, bookID); err != nil {
			return fmt.Errorf("clear default file: %w", err)
		}
		if fileID != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE book_files SET is_default = 1 WHERE id = ? AND book_id = ?`, *fileID, bookID); err != nil {
				return fmt.Errorf("set default file: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE books SET updated_at = ? WHERE id = ?`, s.now().UnixMilli(), bookID); err != nil {
			return fmt.Errorf("touch book: %w", err)
		}
		return nil
	})
	if err != nil {
		return Book{}, err
	}
	return s.GetBook(ctx, viewer, bookID)
}
