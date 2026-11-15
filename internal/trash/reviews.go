package trash

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"pandalibrary/internal/catalog"
)

func applyReview(ctx context.Context, tx *sql.Tx, v catalog.Viewer, rawID string, restore bool) error {
	id, err := positiveID(rawID)
	if err != nil {
		return err
	}
	var originalID, bookID, userID, createdAt, updatedAt int64
	var body string
	err = tx.QueryRowContext(ctx, `SELECT r.original_id,r.book_id,r.user_id,r.body,r.created_at,r.updated_at
		FROM trash_reviews r JOIN active_books b ON b.id=r.book_id WHERE r.id=? AND `+visibleDeletedReview+` AND `+visibleBook,
		id, v.UserID, admin(v), v.UserID, admin(v), v.UserID, v.UserID).
		Scan(&originalID, &bookID, &userID, &body, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return catalog.ErrNotFound
	}
	if err != nil {
		return err
	}
	if restore {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM book_reviews WHERE book_id=? AND user_id=?)`, bookID, userID).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return fmt.Errorf("%w: a review already exists for this book and user", catalog.ErrConflict)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO book_reviews(id,book_id,user_id,body,created_at,updated_at)
			VALUES (CASE WHEN EXISTS(SELECT 1 FROM book_reviews WHERE id=?) THEN NULL ELSE ? END,?,?,?,?,?)`,
			originalID, originalID, bookID, userID, body, createdAt, updatedAt); err != nil {
			return err
		}
	}
	return changed(tx.ExecContext(ctx, `DELETE FROM trash_reviews WHERE id=?`, id))
}
