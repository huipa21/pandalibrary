// Package trash provides transactional recovery and disposal of deleted items.
package trash

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/search"
)

type Item struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	Subtitle  string `json:"subtitle,omitempty"`
	DeletedAt string `json:"deletedAt"`
}

type Ref struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

type Service struct{ writer *sql.DB }

func NewService(writer *sql.DB) *Service { return &Service{writer: writer} }

const visibleBook = `(b.visibility = 'public' OR b.owner_id = ? OR
	(b.visibility = 'library' AND (? = 1 OR EXISTS
	(SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = ?))))
	AND NOT EXISTS (SELECT 1 FROM book_hidden bh WHERE bh.book_id = b.id AND bh.user_id = ?)`

const visibleDeletedReview = `((r.user_id = ? AND r.deleted_by = r.user_id) OR
	(? = 1 AND COALESCE(r.deleted_by, 0) != r.user_id))`

var annotationTables = map[string]string{
	"highlight": "highlights", "note": "notes", "page": "page_annotations",
}

func admin(v catalog.Viewer) int {
	if v.IsAdmin {
		return 1
	}
	return 0
}

func (s *Service) List(ctx context.Context, v catalog.Viewer, kind, query string) ([]Item, error) {
	if v.UserID <= 0 || (kind != "" && kind != "book" && kind != "wordbook" && kind != "annotation") {
		return nil, fmt.Errorf("%w: invalid trash filter", catalog.ErrInvalid)
	}
	items := []Item{}
	appendRows := func(rows *sql.Rows, typ, prefix string) error {
		defer rows.Close()
		for rows.Next() {
			var id, title, subtitle string
			var deleted int64
			if err := rows.Scan(&id, &title, &subtitle, &deleted); err != nil {
				return err
			}
			if query != "" && !strings.Contains(strings.ToLower(title+" "+subtitle), strings.ToLower(query)) {
				continue
			}
			items = append(items, Item{ID: prefix + id, Type: typ, Title: title, Subtitle: subtitle,
				DeletedAt: time.UnixMilli(deleted).UTC().Format("2006-01-02T15:04:05.000Z")})
		}
		return rows.Err()
	}
	run := func(typ, prefix, statement string, args ...any) error {
		rows, err := s.writer.QueryContext(ctx, statement, args...)
		if err != nil {
			return err
		}
		return appendRows(rows, typ, prefix)
	}
	if (kind == "" || kind == "book") && v.IsAdmin {
		if err := run("book", "", `SELECT CAST(b.id AS TEXT), b.title, COALESCE(b.subtitle,''), b.deleted_at FROM books b WHERE b.deleted_at IS NOT NULL AND `+visibleBook,
			v.UserID, admin(v), v.UserID, v.UserID); err != nil {
			return nil, err
		}
	}
	if kind == "" || kind == "wordbook" {
		if err := run("wordbook", "", `SELECT CAST(id AS TEXT), name, '', deleted_at FROM wordbooks WHERE user_id = ? AND deleted_at IS NOT NULL`, v.UserID); err != nil {
			return nil, err
		}
	}
	if kind == "" || kind == "annotation" {
		for _, a := range []struct{ prefix, table, title string }{
			{"highlight:", "highlights", "a.text"}, {"note:", "notes", "a.body_md"},
			{"page:", "page_annotations", "COALESCE(json_extract(a.data, '$.text'), a.kind)"},
		} {
			sql := `SELECT a.id, ` + a.title + `, b.title, a.deleted_at FROM ` + a.table + ` a
				JOIN active_books b ON b.id = a.book_id WHERE a.user_id = ? AND a.deleted_at IS NOT NULL AND a.purged = 0 AND ` + visibleBook
			if a.table == "notes" {
				sql += ` AND NOT EXISTS (SELECT 1 FROM trash_highlight_notes t JOIN highlights h ON h.id=t.highlight_id WHERE t.note_id=a.id AND t.deleted_rev=a.rev AND h.deleted_at IS NOT NULL AND h.purged=0)`
			}
			if err := run("annotation", a.prefix, sql, v.UserID, v.UserID, admin(v), v.UserID, v.UserID); err != nil {
				return nil, err
			}
		}
		if err := run("annotation", "review:", `SELECT CAST(r.id AS TEXT), r.body, b.title, r.deleted_at
			FROM trash_reviews r JOIN active_books b ON b.id = r.book_id WHERE `+visibleDeletedReview+` AND `+visibleBook,
			v.UserID, admin(v), v.UserID, admin(v), v.UserID, v.UserID); err != nil {
			return nil, err
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].DeletedAt == items[j].DeletedAt {
			if items[i].Type == items[j].Type {
				return items[i].ID < items[j].ID
			}
			return items[i].Type < items[j].Type
		}
		return items[i].DeletedAt > items[j].DeletedAt
	})
	return items, nil
}

// Apply changes all requested items atomically; unavailable items abort the batch.
func (s *Service) Apply(ctx context.Context, v catalog.Viewer, refs []Ref, restore bool) error {
	if v.UserID <= 0 || len(refs) == 0 || len(refs) > 500 {
		return fmt.Errorf("%w: supply between 1 and 500 items", catalog.ErrInvalid)
	}
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, ref := range refs {
		if err := applyOne(ctx, tx, v, ref, restore); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func positiveID(id string) (int64, error) {
	n, err := strconv.ParseInt(id, 10, 64)
	if err != nil || n <= 0 || strconv.FormatInt(n, 10) != id {
		return 0, fmt.Errorf("%w: invalid item ID", catalog.ErrInvalid)
	}
	return n, nil
}

func changed(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return catalog.ErrNotFound
	}
	return nil
}

func applyOne(ctx context.Context, tx *sql.Tx, v catalog.Viewer, ref Ref, restore bool) error {
	switch ref.Type {
	case "book":
		if !v.IsAdmin {
			return catalog.ErrForbidden
		}
		id, err := positiveID(ref.ID)
		if err != nil {
			return err
		}
		var exists int
		err = tx.QueryRowContext(ctx, `SELECT 1 FROM books b WHERE b.id=? AND b.deleted_at IS NOT NULL AND `+visibleBook,
			id, v.UserID, admin(v), v.UserID, v.UserID).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return catalog.ErrNotFound
		}
		if err != nil {
			return err
		}
		if restore {
			if err := changed(tx.ExecContext(ctx, `UPDATE books SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`, id)); err != nil {
				return err
			}
			if err := search.IndexBook(ctx, tx, id); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO highlights_fts(rowid,text,user_id,book_id) SELECT seq,text,user_id,book_id FROM highlights WHERE book_id = ? AND deleted_at IS NULL`, id); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO notes_fts(rowid,body,highlight_text,user_id,book_id)
				SELECT n.seq,n.body_md,COALESCE(h.text,''),n.user_id,n.book_id FROM notes n
				LEFT JOIN highlights h ON h.id=n.highlight_id AND h.deleted_at IS NULL
				JOIN active_books b ON b.id=n.book_id
				WHERE n.deleted_at IS NULL AND (n.book_id = ? OR h.book_id = ?)`, id, id); err != nil {
				return err
			}
			return nil
		}
		rows, err := tx.QueryContext(ctx, `SELECT author_id FROM book_authors WHERE book_id = ?`, id)
		if err != nil {
			return err
		}
		var authors []int64
		for rows.Next() {
			var author int64
			if err := rows.Scan(&author); err != nil {
				rows.Close()
				return err
			}
			authors = append(authors, author)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if err := changed(tx.ExecContext(ctx, `DELETE FROM books WHERE id = ? AND deleted_at IS NOT NULL`, id)); err != nil {
			return err
		}
		for _, author := range authors {
			if _, err := tx.ExecContext(ctx, `DELETE FROM authors WHERE id = ? AND NOT EXISTS (SELECT 1 FROM book_authors WHERE author_id = ?)`, author, author); err != nil {
				return err
			}
		}
		return nil
	case "wordbook":
		id, err := positiveID(ref.ID)
		if err != nil {
			return err
		}
		if restore {
			return changed(tx.ExecContext(ctx, `UPDATE wordbooks SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`, id, v.UserID))
		}
		return changed(tx.ExecContext(ctx, `DELETE FROM wordbooks WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`, id, v.UserID))
	case "annotation":
		parts := strings.SplitN(ref.ID, ":", 2)
		if len(parts) != 2 || parts[1] == "" {
			return fmt.Errorf("%w: invalid annotation ID", catalog.ErrInvalid)
		}
		if parts[0] == "review" {
			return applyReview(ctx, tx, v, parts[1], restore)
		}
		if annotationTables[parts[0]] == "" {
			return fmt.Errorf("%w: invalid annotation ID", catalog.ErrInvalid)
		}
		table := annotationTables[parts[0]]
		var updated int64
		err := tx.QueryRowContext(ctx, `SELECT a.updated_at FROM `+table+` a JOIN active_books b ON b.id = a.book_id
			WHERE a.id = ? AND a.user_id = ? AND a.deleted_at IS NOT NULL AND a.purged = 0 AND `+visibleBook,
			parts[1], v.UserID, v.UserID, admin(v), v.UserID, v.UserID).Scan(&updated)
		if errors.Is(err, sql.ErrNoRows) {
			return catalog.ErrNotFound
		}

		if err != nil {
			return err
		}
		if restore {
			if table == "notes" {
				var blocked int
				if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM notes n JOIN highlights h ON h.id=n.highlight_id WHERE n.id=? AND (h.deleted_at IS NOT NULL OR h.purged != 0))`, parts[1]).Scan(&blocked); err != nil {
					return err
				}
				if blocked != 0 {
					return fmt.Errorf("%w: restore the highlight before its note", catalog.ErrConflict)
				}
			}
			rev, err := db.NextRev(ctx, tx)
			if err != nil {
				return err
			}
			stamp := max(time.Now().UTC().UnixMilli(), updated+1)
			if err := changed(tx.ExecContext(ctx, `UPDATE `+table+` SET deleted_at = NULL, updated_at = ?, rev = ? WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL AND purged = 0`, stamp, rev, parts[1], v.UserID)); err != nil {
				return err
			}
			if table == "highlights" {
				_, err = tx.ExecContext(ctx, `INSERT INTO highlights_fts(rowid,text,user_id,book_id) SELECT seq,text,user_id,book_id FROM highlights WHERE id = ?`, parts[1])
			} else if table == "notes" {
				_, err = tx.ExecContext(ctx, `INSERT INTO notes_fts(rowid,body,highlight_text,user_id,book_id) SELECT n.seq,n.body_md,h.text,n.user_id,n.book_id FROM notes n JOIN highlights h ON h.id=n.highlight_id AND h.deleted_at IS NULL WHERE n.id = ?`, parts[1])
			}
			if err != nil || table != "highlights" {
				return err
			}
			rows, err := tx.QueryContext(ctx, `SELECT n.id,n.updated_at FROM trash_highlight_notes t JOIN notes n ON n.id=t.note_id
				WHERE t.highlight_id=? AND n.user_id=? AND n.deleted_at IS NOT NULL AND n.purged=0 AND n.rev=t.deleted_rev`, parts[1], v.UserID)
			if err != nil {
				return err
			}
			type child struct {
				id      string
				updated int64
			}
			var children []child
			for rows.Next() {
				var c child
				if err := rows.Scan(&c.id, &c.updated); err != nil {
					rows.Close()
					return err
				}
				children = append(children, c)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
			for _, c := range children {
				rev, err := db.NextRev(ctx, tx)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `UPDATE notes SET deleted_at=NULL, updated_at=?, rev=? WHERE id=?`, max(time.Now().UTC().UnixMilli(), c.updated+1), rev, c.id); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO notes_fts(rowid,body,highlight_text,user_id,book_id)
					SELECT n.seq,n.body_md,h.text,n.user_id,n.book_id FROM notes n JOIN highlights h ON h.id=n.highlight_id WHERE n.id=?`, c.id); err != nil {
					return err
				}
			}
			_, err = tx.ExecContext(ctx, `DELETE FROM trash_highlight_notes WHERE highlight_id=?`, parts[1])
			return err
		}
		// Keep a content-free sync tombstone so offline devices cannot resurrect the item.
		scrub := map[string]string{
			"highlights":       `text='', chapter=NULL, locator='{}'`,
			"notes":            `body_md=''`,
			"page_annotations": `data='{}', locator='{}', asset_sha256=NULL`,
		}[table]
		if err := changed(tx.ExecContext(ctx, `UPDATE `+table+` SET purged=1, `+scrub+` WHERE id=? AND user_id=? AND deleted_at IS NOT NULL AND purged=0`, parts[1], v.UserID)); err != nil {
			return err
		}
		if table == "highlights" {
			if _, err := tx.ExecContext(ctx, `UPDATE notes SET purged=1, body_md='' WHERE user_id=? AND highlight_id=? AND deleted_at IS NOT NULL`, v.UserID, parts[1]); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `DELETE FROM trash_highlight_notes WHERE highlight_id=?`, parts[1])
			return err
		}
		return nil
	default:
		return fmt.Errorf("%w: invalid item type", catalog.ErrInvalid)
	}
}
