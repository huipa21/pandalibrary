package catalog

import (
	"context"
	"database/sql"
	"errors"
)

// SetVisibility changes sharing only for the trusted owner, never for other admins.
func (s *Service) SetVisibility(ctx context.Context, viewer Viewer, id int64, visibility string) (Book, error) {
	if err := checkViewer(viewer); err != nil {
		return Book{}, err
	}
	if id < 1 || (visibility != "public" && visibility != "private") {
		return Book{}, invalid("visibility must be public or private")
	}
	if _, err := s.GetBook(ctx, viewer, id); err != nil {
		return Book{}, err
	}
	result, err := s.writer.ExecContext(ctx, `UPDATE books SET visibility = ?, updated_at = ?
		WHERE id = ? AND owner_id = ?`, visibility, s.now().UnixMilli(), id, viewer.UserID)
	if err != nil {
		return Book{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Book{}, err
	}
	if affected == 0 {
		var owner sql.NullInt64
		err := s.reader.QueryRowContext(ctx, `SELECT owner_id FROM books WHERE id = ?`, id).Scan(&owner)
		if errors.Is(err, sql.ErrNoRows) {
			return Book{}, ErrNotFound
		}
		if err != nil {
			return Book{}, err
		}
		return Book{}, ErrForbidden
	}
	return s.GetBook(ctx, viewer, id)
}
