package bookheap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"unicode/utf8"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

const (
	defaultPageSize = 50
	maximumPageSize = 100
	maxQueryRunes   = 200
	maxCursorBytes  = 512
	// MaxDeleteIDs is the largest bulk delete request.
	MaxDeleteIDs = 500
)

// Per-item delete errors.
const (
	DeleteNotFound = "not_found"
	DeleteBusy     = "busy"
	DeleteChanged  = "changed"
	DeleteFailed   = "failed"
)

var validStatuses = map[string]bool{
	StatusReady: true, StatusDuplicate: true, StatusInvalid: true,
	StatusQueued: true, StatusImporting: true, StatusFailed: true,
}

// ListOptions filters and pages heap items.
type ListOptions struct {
	Status string
	Query  string
	Limit  int
	Cursor string
}

// ListPage is the list response; Total counts every item matching the filter.
type ListPage struct {
	Items      []Item  `json:"items"`
	NextCursor *string `json:"next_cursor"`
	Total      int64   `json:"total"`
}

type listCursor struct {
	Version int    `json:"v"`
	Filter  string `json:"f"`
	Created int64  `json:"c"`
	ID      int64  `json:"i"`
}

func filterKey(status, query string) string {
	sum := sha256.Sum256([]byte(status + "\x00" + query))
	return hex.EncodeToString(sum[:8])
}

// List returns items newest first (created_at, then id, descending).
func (s *Service) List(ctx context.Context, viewer catalog.Viewer, options ListOptions) (ListPage, error) {
	page := ListPage{Items: []Item{}}
	if err := checkAdmin(viewer); err != nil {
		return page, err
	}
	if options.Status != "" && !validStatuses[options.Status] {
		return page, fmt.Errorf("%w: the status filter is invalid", catalog.ErrInvalid)
	}
	query := strings.TrimSpace(options.Query)
	if !utf8.ValidString(query) || utf8.RuneCountInString(query) > maxQueryRunes {
		return page, fmt.Errorf("%w: the search query is invalid", catalog.ErrInvalid)
	}
	limit := options.Limit
	if limit == 0 {
		limit = defaultPageSize
	}
	if limit < 1 || limit > maximumPageSize {
		return page, fmt.Errorf("%w: limit must be between 1 and 100", catalog.ErrInvalid)
	}
	key := filterKey(options.Status, query)
	var position listCursor
	if options.Cursor != "" {
		var err error
		position, err = decodeCursor(options.Cursor, key)
		if err != nil {
			return page, err
		}
	}
	queries := sqlc.New(s.reader)
	rows, err := queries.BookheapList(ctx, sqlc.BookheapListParams{
		Status: options.Status, Query: query, CursorID: position.ID, CursorCreated: position.Created, PageLimit: int64(limit + 1),
	})
	if err != nil {
		return page, fmt.Errorf("list bookheap items: %w", err)
	}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		encoded, err := json.Marshal(listCursor{Version: 1, Filter: key, Created: last.CreatedAt, ID: last.ID})
		if err != nil {
			return page, err
		}
		token := base64.RawURLEncoding.EncodeToString(encoded)
		page.NextCursor = &token
	}
	for _, row := range rows {
		page.Items = append(page.Items, itemDTO(row))
	}
	page.Total, err = queries.BookheapCount(ctx, sqlc.BookheapCountParams{Status: options.Status, Query: query})
	if err != nil {
		return page, fmt.Errorf("count bookheap items: %w", err)
	}
	return page, nil
}

func decodeCursor(token, key string) (listCursor, error) {
	invalid := fmt.Errorf("%w: the cursor is invalid", catalog.ErrInvalid)
	if len(token) > maxCursorBytes {
		return listCursor{}, invalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return listCursor{}, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var result listCursor
	if err := decoder.Decode(&result); err != nil {
		return listCursor{}, invalid
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) || result.Version != 1 || result.Filter != key || result.ID < 1 {
		return listCursor{}, fmt.Errorf("%w: the cursor does not match this list", catalog.ErrInvalid)
	}
	return result, nil
}

// Get returns one item.
func (s *Service) Get(ctx context.Context, viewer catalog.Viewer, itemID int64) (Item, error) {
	if err := checkAdmin(viewer); err != nil {
		return Item{}, err
	}
	row, err := s.row(ctx, itemID)
	if err != nil {
		return Item{}, err
	}
	return itemDTO(row), nil
}

func (s *Service) row(ctx context.Context, itemID int64) (sqlc.BookheapItem, error) {
	if itemID < 1 {
		return sqlc.BookheapItem{}, fmt.Errorf("%w: the item ID is invalid", catalog.ErrInvalid)
	}
	row, err := sqlc.New(s.reader).BookheapGet(ctx, itemID)
	if errors.Is(err, sql.ErrNoRows) {
		return row, catalog.ErrNotFound
	}
	if err != nil {
		return row, fmt.Errorf("get bookheap item: %w", err)
	}
	return row, nil
}

// OpenCover opens an item's normalized cover or its thumbnail as a JPEG.
func (s *Service) OpenCover(ctx context.Context, viewer catalog.Viewer, itemID int64, thumbnail bool) (catalog.Content, error) {
	if err := checkAdmin(viewer); err != nil {
		return catalog.Content{}, err
	}
	row, err := s.row(ctx, itemID)
	if err != nil {
		return catalog.Content{}, err
	}
	if !row.CoverSha256.Valid {
		return catalog.Content{}, catalog.ErrNotFound
	}
	file, err := s.blobs.OpenCover(row.CoverSha256.String, thumbnail)
	if errors.Is(err, fs.ErrNotExist) {
		return catalog.Content{}, catalog.ErrNotFound
	}
	if err != nil {
		return catalog.Content{}, fmt.Errorf("open bookheap cover: %w", err)
	}
	etag := row.CoverSha256.String
	if thumbnail {
		etag += "-w400"
	}
	return catalog.Content{File: file, Filename: "cover.jpg", ContentType: "image/jpeg", ETag: etag}, nil
}

// DeleteResult is the per-item outcome of a bulk delete. Error is null on success.
type DeleteResult struct {
	ID    int64   `json:"id"`
	OK    bool    `json:"ok"`
	Error *string `json:"error"`
}

// Delete removes 1..500 unique items: first the file (only if it still matches
// the stored size and mtime), then the row. Queued or importing items are busy.
func (s *Service) Delete(ctx context.Context, viewer catalog.Viewer, ids []int64) ([]DeleteResult, error) {
	if err := checkAdmin(viewer); err != nil {
		return nil, err
	}
	if len(ids) < 1 || len(ids) > MaxDeleteIDs {
		return nil, fmt.Errorf("%w: ids must contain 1 to %d items", catalog.ErrInvalid, MaxDeleteIDs)
	}
	seen := make(map[int64]bool, len(ids))
	for _, itemID := range ids {
		if itemID < 1 || seen[itemID] {
			return nil, fmt.Errorf("%w: ids must be unique positive integers", catalog.ErrInvalid)
		}
		seen[itemID] = true
	}
	if s.isStopped() {
		return nil, ErrStopped
	}
	results := make([]DeleteResult, 0, len(ids))
	for _, itemID := range ids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		code, err := s.deleteItem(ctx, itemID, false)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			s.logger.Error("delete bookheap item", "item_id", itemID, "error", s.safeError(err))
			code = DeleteFailed
		}
		result := DeleteResult{ID: itemID, OK: code == ""}
		if code != "" {
			result.Error = &code
		}
		results = append(results, result)
	}
	return results, nil
}

// deleteItem removes one item's file and row and returns a per-item error code.
// allowBusy lets assignment remove queued/importing items after a successful import.
func (s *Service) deleteItem(ctx context.Context, itemID int64, allowBusy bool) (code string, returnErr error) {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	root, err := os.OpenRoot(s.dir)
	if err != nil {
		return "", fmt.Errorf("open bookheap: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		row, err := queries.BookheapGet(ctx, itemID)
		if errors.Is(err, sql.ErrNoRows) {
			code = DeleteNotFound
			return nil
		}
		if err != nil {
			return err
		}
		if !allowBusy && (row.Status == StatusQueued || row.Status == StatusImporting) {
			code = DeleteBusy
			return nil
		}
		info, err := lstatRegular(root, row.RelPath)
		switch {
		case errors.Is(err, fs.ErrNotExist):
		case err != nil:
			code = DeleteChanged
			return nil
		case info.Size() != row.SizeBytes || info.ModTime().UnixNano() != row.MtimeNs:
			code = DeleteChanged
			return nil
		default:
			if err := root.Remove(native(row.RelPath)); err != nil && !errors.Is(err, fs.ErrNotExist) {
				return fmt.Errorf("remove bookheap file: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM bookheap_items WHERE id = ?", itemID); err != nil {
			return fmt.Errorf("delete bookheap row: %w", err)
		}
		return nil
	})
	return code, err
}
