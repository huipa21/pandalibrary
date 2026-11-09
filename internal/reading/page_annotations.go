package reading

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

const (
	maxPageAnnotationData = 64 << 10
	maxAnnotationText     = 4000
	maxAnnotationStrokes  = 200
	maxAnnotationPoints   = 10000
)

type pageAnnotationData struct {
	BookID     int64           `json:"book_id"`
	BookFileID *int64          `json:"book_file_id"`
	Kind       string          `json:"kind"`
	Locator    json.RawMessage `json:"locator"`
	Position   *float64        `json:"position"`
	Data       json.RawMessage `json:"data"`
	CreatedAt  *int64          `json:"created_at"`
}

type pageAnnotationLocator struct {
	Type string             `json:"type"`
	Page *int64             `json:"page"`
	Rect *bookmarkRectangle `json:"rect"`
}

func validPageAnnotationLocator(raw json.RawMessage) bool {
	if len(raw) == 0 || len(raw) > maxLocatorBytes {
		return false
	}
	var locator pageAnnotationLocator
	if err := decodeMutationData(raw, &locator); err != nil || locator.Type != "pdf" ||
		locator.Page == nil || *locator.Page < 1 || *locator.Page > 1<<53-1 || locator.Rect == nil {
		return false
	}
	rect := locator.Rect
	if rect.X == nil || rect.Y == nil || rect.Width == nil || rect.Height == nil {
		return false
	}
	x, y, width, height := *rect.X, *rect.Y, *rect.Width, *rect.Height
	return validNumberInRange(x, 0, 1) && validNumberInRange(y, 0, 1) &&
		validNumberInRange(width, 0, 1) && validNumberInRange(height, 0, 1) &&
		width > 0 && height > 0 && x+width <= 1 && y+height <= 1
}

func validNumberInRange(value, minValue, maxValue float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= minValue && value <= maxValue
}

func validLowerHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, char := range value {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func validAnnotationColor(color string) bool {
	return len(color) == 7 && color[0] == '#' && validLowerHex(color[1:], 6)
}

// validPageAnnotationData returns the owned asset hash for an image, if present.
func validPageAnnotationData(kind string, raw json.RawMessage) (*string, bool) {
	if len(raw) == 0 || len(raw) > maxPageAnnotationData || !utf8.Valid(raw) {
		return nil, false
	}
	switch kind {
	case "text":
		var data struct {
			Text  *string  `json:"text"`
			Color *string  `json:"color"`
			Size  *float64 `json:"size"`
		}
		if err := decodeMutationData(raw, &data); err != nil || data.Text == nil ||
			data.Color == nil || data.Size == nil {
			return nil, false
		}
		count := utf8.RuneCountInString(*data.Text)
		return nil, count >= 1 && count <= maxAnnotationText && !strings.ContainsRune(*data.Text, 0) &&
			validAnnotationColor(*data.Color) && validNumberInRange(*data.Size, 0.008, 0.08)
	case "ink":
		var data struct {
			Color   *string      `json:"color"`
			Width   *float64     `json:"width"`
			Strokes [][]*float64 `json:"strokes"`
		}
		if err := decodeMutationData(raw, &data); err != nil || data.Color == nil || data.Width == nil ||
			!validAnnotationColor(*data.Color) || !validNumberInRange(*data.Width, 0.001, 0.02) ||
			len(data.Strokes) < 1 || len(data.Strokes) > maxAnnotationStrokes {
			return nil, false
		}
		points := 0
		for _, stroke := range data.Strokes {
			if len(stroke) < 2 || len(stroke)%2 != 0 {
				return nil, false
			}
			points += len(stroke) / 2
			if points > maxAnnotationPoints {
				return nil, false
			}
			for _, coordinate := range stroke {
				if coordinate == nil || !validNumberInRange(*coordinate, 0, 1) {
					return nil, false
				}
			}
		}
		return nil, true
	case "image":
		var data struct {
			Asset     *string `json:"asset"`
			MediaType *string `json:"media_type"`
			Width     *int64  `json:"width"`
			Height    *int64  `json:"height"`
		}
		if err := decodeMutationData(raw, &data); err != nil || data.Asset == nil || data.MediaType == nil ||
			data.Width == nil || data.Height == nil || !validLowerHex(*data.Asset, 64) ||
			(*data.MediaType != "image/png" && *data.MediaType != "image/jpeg" && *data.MediaType != "image/webp") ||
			*data.Width < 1 || *data.Width > 8192 || *data.Height < 1 || *data.Height > 8192 {
			return nil, false
		}
		return data.Asset, true
	default:
		return nil, false
	}
}

func toPageAnnotation(row sqlc.PageAnnotation) PageAnnotation {
	return PageAnnotation{
		ID: row.ID, BookID: row.BookID, BookFileID: nullableInt(row.BookFileID), Kind: row.Kind,
		Locator: json.RawMessage(row.Locator), Position: row.Position, Data: json.RawMessage(row.Data),
		CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt),
		DeletedAt: nullableTime(row.DeletedAt), Rev: row.Rev,
	}
}

func (s *Service) applyPageAnnotation(
	ctx context.Context, q *sqlc.Queries, tx *sql.Tx, viewer Viewer, mutation Mutation, updatedAt, now int64,
) (string, string, error) {
	id := mutationID(mutation)
	if !validUUIDv7(id) {
		return reject("page annotation ID must be a UUIDv7")
	}
	owner, err := q.ReadingGetPageAnnotationOwner(ctx, id)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", "", fmt.Errorf("check page annotation ownership: %w", err)
	}
	if exists && owner != viewer.UserID {
		return reject("page annotation is owned by another user")
	}
	var existing sqlc.PageAnnotation
	if exists {
		existing, err = q.ReadingGetOwnedPageAnnotation(ctx, sqlc.ReadingGetOwnedPageAnnotationParams{
			ID: id, UserID: viewer.UserID, IsAdmin: adminFlag(viewer),
		})
		if errors.Is(err, sql.ErrNoRows) {
			return reject("page annotation book is unavailable")
		}
		if err != nil {
			return "", "", fmt.Errorf("get owned page annotation: %w", err)
		}
		if updatedAt <= existing.UpdatedAt {
			return stale()
		}
	}
	if mutation.Op == "delete" {
		if !exists {
			return reject("page annotation does not exist")
		}
		if existing.DeletedAt.Valid {
			return stale()
		}
		rev, err := db.NextRev(ctx, tx)
		if err != nil {
			return "", "", err
		}
		if err := q.ReadingTombstonePageAnnotation(ctx, sqlc.ReadingTombstonePageAnnotationParams{
			ID: id, UserID: viewer.UserID, UpdatedAt: updatedAt,
			DeletedAt: sql.NullInt64{Int64: updatedAt, Valid: true}, Rev: rev,
		}); err != nil {
			return "", "", fmt.Errorf("tombstone page annotation: %w", err)
		}
		return applied()
	}

	var data pageAnnotationData
	if err := decodeMutationData(mutation.Data, &data); err != nil {
		return reject("page annotation data is invalid")
	}
	if data.BookID < 1 || data.BookFileID != nil && *data.BookFileID < 1 ||
		data.Position == nil || !validNumberInRange(*data.Position, 0, 1) {
		return reject("page annotation fields are invalid")
	}
	if !validPageAnnotationLocator(data.Locator) {
		return reject("page annotation locator is invalid")
	}
	if data.Kind != "text" && data.Kind != "ink" && data.Kind != "image" {
		return reject("page annotation kind is invalid")
	}
	asset, valid := validPageAnnotationData(data.Kind, data.Data)
	if !valid {
		return reject("page annotation content is invalid")
	}
	if exists && existing.BookID != data.BookID {
		return reject("page annotation cannot be moved to another book")
	}
	if exists && existing.Kind != data.Kind {
		return reject("page annotation kind cannot change")
	}
	if err := s.requireVisibleBook(ctx, q, viewer, data.BookID); errors.Is(err, ErrNotFound) {
		return reject("book is unavailable")
	} else if err != nil {
		return "", "", err
	}
	if data.BookFileID != nil {
		if _, err := q.ReadingVisibleBookFile(ctx, sqlc.ReadingVisibleBookFileParams{
			BookID: data.BookID, BookFileID: *data.BookFileID, UserID: viewer.UserID, IsAdmin: adminFlag(viewer),
		}); errors.Is(err, sql.ErrNoRows) {
			return reject("book file is unavailable")
		} else if err != nil {
			return "", "", fmt.Errorf("check page annotation book file: %w", err)
		}
	}
	if asset != nil {
		if _, err := q.ReadingGetAnnotationAsset(ctx, sqlc.ReadingGetAnnotationAssetParams{
			UserID: viewer.UserID, Sha256: *asset,
		}); errors.Is(err, sql.ErrNoRows) {
			return reject("annotation asset is unavailable")
		} else if err != nil {
			return "", "", fmt.Errorf("check annotation asset: %w", err)
		}
	}
	createdAt := now
	if exists {
		createdAt = existing.CreatedAt
	} else if data.CreatedAt != nil {
		if *data.CreatedAt < 0 {
			return reject("created_at must be non-negative")
		}
		createdAt = min(*data.CreatedAt, now)
	}
	rev, err := db.NextRev(ctx, tx)
	if err != nil {
		return "", "", err
	}
	rows, err := q.ReadingUpsertPageAnnotation(ctx, sqlc.ReadingUpsertPageAnnotationParams{
		ID: id, UserID: viewer.UserID, BookID: data.BookID, IsAdmin: adminFlag(viewer),
		BookFileID: nullableIntInput(data.BookFileID), Kind: data.Kind, Locator: string(data.Locator),
		Position: *data.Position, Data: string(data.Data), AssetSha256: nullableStringInput(asset),
		CreatedAt: createdAt, UpdatedAt: updatedAt, Rev: rev,
	})
	if err != nil {
		return "", "", fmt.Errorf("upsert page annotation: %w", err)
	}
	if rows != 1 {
		return reject("book is unavailable")
	}
	return applied()
}
