package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"pandalibrary/internal/blobstore"
)

// PersonalActivity is one review or annotation authored by the current viewer.
type PersonalActivity struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	BookID      int64           `json:"book_id"`
	BookTitle   string          `json:"book_title"`
	CoverURL    *string         `json:"cover_url"`
	Content     string          `json:"content"`
	Anchor      string          `json:"anchor,omitempty"`
	BookFileID  *int64          `json:"book_file_id,omitempty"`
	HighlightID *string         `json:"highlight_id,omitempty"`
	Locator     json.RawMessage `json:"locator,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

type PersonalActivityOptions struct {
	Limit  int
	Cursor string
	Kind   string
}

type PersonalActivityPage struct {
	Page[PersonalActivity]
	Total int64 `json:"total"`
}

const personalActivitySource = `
WITH activity AS (
	SELECT 'review' AS kind, CAST(r.id AS TEXT) AS id, r.book_id, b.title AS book_title,
		b.cover_sha256, r.body AS content, '' AS anchor, r.created_at, r.updated_at,
		NULL AS book_file_id, '' AS locator, '' AS data, NULL AS highlight_id
	FROM book_reviews r
	JOIN books b ON b.id = r.book_id
	WHERE r.user_id = ?
	AND (b.owner_id = ? OR b.visibility = 'public' OR (b.visibility = 'library' AND (? = 1 OR EXISTS (
		SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = ?
	))))
	AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = ?)
	UNION ALL
	SELECT 'comment' AS kind,
		n.id, n.book_id, b.title AS book_title, b.cover_sha256, n.body_md AS content,
		COALESCE(h.text, '') AS anchor, n.created_at, n.updated_at, h.book_file_id, '', '', n.highlight_id
	FROM notes n
	JOIN books b ON b.id = n.book_id
	LEFT JOIN highlights h ON h.id = n.highlight_id AND h.user_id = n.user_id
		AND h.book_id = n.book_id AND h.deleted_at IS NULL
	WHERE n.user_id = ? AND n.deleted_at IS NULL AND n.highlight_id IS NOT NULL
	AND (b.owner_id = ? OR b.visibility = 'public' OR (b.visibility = 'library' AND (? = 1 OR EXISTS (
		SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = ?
	))))
	AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = ?)
	UNION ALL
	SELECT h.style, h.id, h.book_id, b.title, b.cover_sha256, h.text, '',
		h.created_at, h.updated_at, h.book_file_id, '', '', h.id
	FROM highlights h JOIN books b ON b.id = h.book_id
	WHERE h.user_id = ? AND h.deleted_at IS NULL
	AND (b.owner_id = ? OR b.visibility = 'public' OR (b.visibility = 'library' AND (? = 1 OR EXISTS (
		SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = ?
	))))
	AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = ?)
	UNION ALL
	SELECT pa.kind, pa.id, pa.book_id, b.title, b.cover_sha256,
		CASE WHEN pa.kind = 'text' THEN json_extract(pa.data, '$.text') ELSE '' END, '',
		pa.created_at, pa.updated_at, pa.book_file_id, pa.locator, pa.data, NULL
	FROM page_annotations pa JOIN books b ON b.id = pa.book_id
	WHERE pa.user_id = ? AND pa.deleted_at IS NULL
	AND (b.owner_id = ? OR b.visibility = 'public' OR (b.visibility = 'library' AND (? = 1 OR EXISTS (
		SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = ?
	))))
	AND NOT EXISTS (SELECT 1 FROM book_hidden hidden WHERE hidden.book_id = b.id AND hidden.user_id = ?)
)`

const personalActivityQuery = personalActivitySource + `
SELECT kind, id, book_id, book_title, cover_sha256, content, anchor, created_at, updated_at,
	book_file_id, locator, data, highlight_id
FROM activity
WHERE (? = '' OR kind = ?)
AND (? = 0 OR created_at < ? OR
	(created_at = ? AND (kind < ? OR (kind = ? AND id < ?))))
ORDER BY created_at DESC, kind DESC, id DESC
LIMIT ?`

// ListPersonalActivity returns the viewer's visible reviews and live annotations newest first.
func (s *Service) ListPersonalActivity(ctx context.Context, viewer Viewer, options PersonalActivityOptions) (PersonalActivityPage, error) {
	if err := checkViewer(viewer); err != nil {
		return PersonalActivityPage{}, err
	}
	if options.Kind != "" && !validActivityKind(options.Kind) {
		return PersonalActivityPage{}, invalid("activity kind is invalid")
	}
	scope := viewerScope(viewer)
	if options.Kind != "" {
		scope += ":" + options.Kind
	}
	limit, after, err := parsePage(PageOptions{Limit: options.Limit, Cursor: options.Cursor}, "personal_activity", scope, "created")
	if err != nil {
		return PersonalActivityPage{}, err
	}
	hasCursor := options.Cursor != ""
	afterKind, afterID := "", ""
	if hasCursor {
		var found bool
		afterKind, afterID, found = strings.Cut(after.Text, ":")
		if !found || !validActivityKind(afterKind) || afterID == "" {
			return PersonalActivityPage{}, invalid("activity cursor is invalid")
		}
	}

	tx, err := s.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return PersonalActivityPage{}, fmt.Errorf("begin personal activity read: %w", err)
	}
	defer tx.Rollback()

	admin := adminFlag(viewer)
	args := []any{
		viewer.UserID, viewer.UserID, admin, viewer.UserID, viewer.UserID,
		viewer.UserID, viewer.UserID, admin, viewer.UserID, viewer.UserID,
		viewer.UserID, viewer.UserID, admin, viewer.UserID, viewer.UserID,
		viewer.UserID, viewer.UserID, admin, viewer.UserID, viewer.UserID,
		options.Kind, options.Kind,
	}
	var total int64
	if err := tx.QueryRowContext(ctx, personalActivitySource+`
		SELECT COUNT(*) FROM activity WHERE (? = '' OR kind = ?)`, args...).Scan(&total); err != nil {
		return PersonalActivityPage{}, fmt.Errorf("count personal activity: %w", err)
	}
	rows, err := tx.QueryContext(ctx, personalActivityQuery, append(args,
		boolInt(hasCursor), after.Time, after.Time, afterKind, afterKind, afterID,
		limit+1,
	)...)
	if err != nil {
		return PersonalActivityPage{}, fmt.Errorf("query personal activity: %w", err)
	}
	items := make([]PersonalActivity, 0, limit+1)
	for rows.Next() {
		var item PersonalActivity
		var coverHash sql.NullString
		var bookFileID sql.NullInt64
		var highlightID sql.NullString
		var locator, data string
		var createdAt, updatedAt int64
		if err := rows.Scan(&item.Kind, &item.ID, &item.BookID, &item.BookTitle, &coverHash,
			&item.Content, &item.Anchor, &createdAt, &updatedAt, &bookFileID, &locator, &data, &highlightID); err != nil {
			_ = rows.Close()
			return PersonalActivityPage{}, fmt.Errorf("scan personal activity: %w", err)
		}
		item.CreatedAt = utcMillis(createdAt)
		item.UpdatedAt = utcMillis(updatedAt)
		if bookFileID.Valid {
			item.BookFileID = &bookFileID.Int64
		}
		if highlightID.Valid {
			item.HighlightID = &highlightID.String
		}
		if locator != "" {
			item.Locator = json.RawMessage(locator)
			item.Data = json.RawMessage(data)
		}
		if coverHash.Valid {
			if !blobstore.ValidHash(coverHash.String) {
				_ = rows.Close()
				return PersonalActivityPage{}, fmt.Errorf("book %d has an invalid cover hash", item.BookID)
			}
			url := fmt.Sprintf("/api/v1/books/%d/cover", item.BookID)
			item.CoverURL = &url
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return PersonalActivityPage{}, fmt.Errorf("read personal activity: %w", err)
	}
	if err := rows.Close(); err != nil {
		return PersonalActivityPage{}, fmt.Errorf("close personal activity rows: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return PersonalActivityPage{}, fmt.Errorf("commit personal activity read: %w", err)
	}
	items, next, err := paginate(items, limit, func(item PersonalActivity) cursor {
		return cursor{
			Version: 1, Kind: "personal_activity", Scope: scope, Sort: "created", ID: 1,
			Text: item.Kind + ":" + item.ID, Time: item.CreatedAt.UnixMilli(),
		}
	})
	if err != nil {
		return PersonalActivityPage{}, err
	}
	return PersonalActivityPage{Page: Page[PersonalActivity]{Items: items, NextCursor: next}, Total: total}, nil
}

func validActivityKind(kind string) bool {
	switch kind {
	case "review", "comment", "highlight", "underline", "strikeout", "text", "ink", "image":
		return true
	default:
		return false
	}
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
