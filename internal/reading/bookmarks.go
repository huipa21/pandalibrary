package reading

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/db/sqlc"
)

type bookmarkRectangle struct {
	X      *float64 `json:"x"`
	Y      *float64 `json:"y"`
	Width  *float64 `json:"width"`
	Height *float64 `json:"height"`
}

type bookmarkLocator struct {
	Type  string              `json:"type"`
	Value *string             `json:"value"`
	Page  *int64              `json:"page"`
	Rects []bookmarkRectangle `json:"rects"`
}

func validBookmarkLocator(raw json.RawMessage, format string) bool {
	var locator bookmarkLocator
	if err := decodeMutationData(raw, &locator); err != nil {
		return false
	}
	switch strings.ToLower(format) {
	case "pdf":
		if locator.Type != "pdf" || locator.Page == nil || *locator.Page < 1 ||
			locator.Value != nil || len(locator.Rects) > 200 {
			return false
		}
		for _, rect := range locator.Rects {
			if rect.X == nil || rect.Y == nil || rect.Width == nil || rect.Height == nil {
				return false
			}
			x, y, width, height := *rect.X, *rect.Y, *rect.Width, *rect.Height
			if math.IsNaN(x) || math.IsNaN(y) || math.IsNaN(width) || math.IsNaN(height) ||
				math.IsInf(x, 0) || math.IsInf(y, 0) || math.IsInf(width, 0) || math.IsInf(height, 0) ||
				x < 0 || y < 0 || x > 1 || y > 1 || width <= 0 || height <= 0 ||
				x+width > 1.00001 || y+height > 1.00001 {
				return false
			}
		}
		return true
	case "epub", "mobi", "azw3", "fb2", "fbz", "cbz":
		return locator.Type == "cfi" && locator.Value != nil && locator.Page == nil &&
			locator.Rects == nil && len(*locator.Value) <= 16000 && utf8.ValidString(*locator.Value) &&
			!strings.ContainsRune(*locator.Value, 0) && strings.HasPrefix(*locator.Value, "epubcfi(") &&
			strings.HasSuffix(*locator.Value, ")")
	default:
		return false
	}
}

type bookmarkCursor struct {
	Version   int    `json:"v"`
	UserID    int64  `json:"u"`
	IsAdmin   bool   `json:"a"`
	BookID    int64  `json:"b"`
	CreatedAt int64  `json:"t"`
	ID        string `json:"i"`
}

func parseBookmarkCursor(token string, viewer Viewer, bookID int64) (bookmarkCursor, error) {
	if token == "" {
		return bookmarkCursor{}, nil
	}
	if len(token) > 4096 {
		return bookmarkCursor{}, fmt.Errorf("%w: cursor is invalid", ErrInvalid)
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return bookmarkCursor{}, fmt.Errorf("%w: cursor is invalid", ErrInvalid)
	}
	var cursor bookmarkCursor
	if err := decodeMutationData(raw, &cursor); err != nil || cursor.Version != 1 ||
		cursor.UserID != viewer.UserID || cursor.IsAdmin != viewer.IsAdmin || cursor.BookID != bookID ||
		cursor.CreatedAt < 0 || !validUUIDv7(cursor.ID) {
		return bookmarkCursor{}, fmt.Errorf("%w: cursor does not match this list", ErrInvalid)
	}
	return cursor, nil
}

// ListUserBookmarks returns visibility-filtered, keyset-paginated saved positions.
func (s *Service) ListUserBookmarks(ctx context.Context, viewer Viewer, options BookmarkPageOptions) (BookmarksListResponse, error) {
	response := BookmarksListResponse{Items: []BookmarkItem{}}
	if err := checkViewer(viewer); err != nil {
		return response, err
	}
	if options.Limit == 0 {
		options.Limit = 20
	}
	if options.Limit < 1 || options.Limit > 100 || options.BookID < 0 {
		return response, fmt.Errorf("%w: bookmark page options are invalid", ErrInvalid)
	}
	after, err := parseBookmarkCursor(options.Cursor, viewer, options.BookID)
	if err != nil {
		return response, err
	}
	err = readSnapshot(ctx, s.reader, func(tx *sql.Tx) error {
		var hasCursor int64
		if options.Cursor != "" {
			hasCursor = 1
		}
		rows, err := sqlc.New(tx).ReadingListUserBookmarks(ctx, sqlc.ReadingListUserBookmarksParams{
			UserID: viewer.UserID, IsAdmin: adminFlag(viewer), BookFilter: options.BookID,
			HasCursor: hasCursor, CursorCreatedAt: after.CreatedAt, CursorID: after.ID,
			Limit: int64(options.Limit + 1),
		})
		if err != nil {
			return fmt.Errorf("list user bookmarks: %w", err)
		}
		hasMore := len(rows) > options.Limit
		if hasMore {
			rows = rows[:options.Limit]
		}
		for _, row := range rows {
			var coverURL *string
			if row.BookCoverSha256.Valid {
				if !blobstore.ValidHash(row.BookCoverSha256.String) {
					return fmt.Errorf("book %d has an invalid cover hash", row.BookID)
				}
				url := fmt.Sprintf("/api/v1/books/%d/cover", row.BookID)
				coverURL = &url
			}
			response.Items = append(response.Items, BookmarkItem{
				Bookmark: toBookmark(sqlc.Bookmark{
					ID: row.ID, BookID: row.BookID, BookFileID: row.BookFileID,
					Locator: row.Locator, Position: row.Position, Label: row.Label,
					Chapter: row.Chapter, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
					DeletedAt: row.DeletedAt, Rev: row.Rev,
				}),
				Book: BookmarkBookSummary{ID: row.BookID, Title: row.BookTitle, CoverURL: coverURL},
			})
		}
		if hasMore {
			last := rows[len(rows)-1]
			raw, err := json.Marshal(bookmarkCursor{
				Version: 1, UserID: viewer.UserID, IsAdmin: viewer.IsAdmin, BookID: options.BookID,
				CreatedAt: last.CreatedAt, ID: last.ID,
			})
			if err != nil {
				return fmt.Errorf("encode bookmark cursor: %w", err)
			}
			token := base64.RawURLEncoding.EncodeToString(raw)
			response.NextCursor = &token
		}
		return nil
	})
	if err != nil {
		return BookmarksListResponse{}, err
	}
	return response, nil
}
