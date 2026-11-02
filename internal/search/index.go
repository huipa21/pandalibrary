package search

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// IndexBook replaces a book's search document inside the caller's write transaction.
func IndexBook(ctx context.Context, tx *sql.Tx, bookID int64) error {
	if tx == nil || bookID < 1 {
		return errors.New("indexing requires a transaction and a positive book ID")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM books_fts WHERE rowid = ?`, bookID); err != nil {
		return fmt.Errorf("remove existing book index: %w", err)
	}
	result, err := tx.ExecContext(ctx, `
INSERT INTO books_fts (rowid, title, authors, series, tags, publisher, identifiers, description)
SELECT b.id, b.title,
    COALESCE((SELECT group_concat(name, ' ') FROM (
        SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
        WHERE ba.book_id = b.id ORDER BY ba.position, a.id, ba.role
    )), ''),
    COALESCE((SELECT s.name FROM series s WHERE s.id = b.series_id), ''),
    COALESCE((SELECT group_concat(name, ' ') FROM (
        SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
        WHERE bt.book_id = b.id ORDER BY t.name COLLATE NOCASE, t.id
    )), ''),
    COALESCE(b.publisher, ''),
    COALESCE((SELECT group_concat(value, ' ') FROM (
        SELECT bi.value FROM book_identifiers bi WHERE bi.book_id = b.id
        ORDER BY bi.scheme, bi.value
    )), ''),
    COALESCE(b.description, '')
FROM books b WHERE b.id = ?`, bookID)
	if err != nil {
		return fmt.Errorf("insert book index: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("check indexed book count: %w", err)
	}
	if count != 1 {
		return fmt.Errorf("index book %d: %w", bookID, sql.ErrNoRows)
	}
	return nil
}
