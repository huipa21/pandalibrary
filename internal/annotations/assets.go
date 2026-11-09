// Package annotations manages private, content-addressed annotation images.
package annotations

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"os"
	"time"

	_ "golang.org/x/image/webp"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/db/sqlc"
)

const MaxBytes = 5 << 20

var (
	ErrTooLarge          = errors.New("asset_too_large")
	ErrUnsupportedMedia  = errors.New("unsupported_media_type")
	ErrInvalidImage      = errors.New("invalid_image")
	ErrInvalidDimensions = errors.New("invalid_image_dimensions")
	ErrInvalidHash       = errors.New("invalid_asset_hash")
	ErrNotFound          = errors.New("asset_not_found")
)

type Asset struct {
	SHA256    string `json:"sha256"`
	MediaType string `json:"media_type"`
	Size      int64  `json:"size"`
	Width     int64  `json:"width"`
	Height    int64  `json:"height"`
}

type Service struct {
	writer *sql.DB
	reader *sql.DB
	blobs  *blobstore.Store
}

func NewService(writer, reader *sql.DB, blobs *blobstore.Store) (*Service, error) {
	if writer == nil || reader == nil || blobs == nil {
		return nil, errors.New("annotation assets require databases and blob storage")
	}
	return &Service{writer: writer, reader: reader, blobs: blobs}, nil
}

func (s *Service) Upload(ctx context.Context, userID int64, mediaType string, content []byte) (Asset, bool, error) {
	if len(content) > MaxBytes {
		return Asset{}, false, ErrTooLarge
	}
	if mediaType != "image/png" && mediaType != "image/jpeg" && mediaType != "image/webp" {
		return Asset{}, false, ErrUnsupportedMedia
	}
	if http.DetectContentType(content) != mediaType {
		return Asset{}, false, ErrInvalidImage
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(content))
	if err != nil {
		return Asset{}, false, ErrInvalidImage
	}
	if config.Width < 1 || config.Height < 1 || config.Width > 8192 || config.Height > 8192 {
		return Asset{}, false, ErrInvalidDimensions
	}
	sum := sha256.Sum256(content)
	asset := Asset{SHA256: hex.EncodeToString(sum[:]), MediaType: mediaType, Size: int64(len(content)),
		Width: int64(config.Width), Height: int64(config.Height)}
	var inserted bool
	err = s.blobs.WithAssetLock(ctx, func() error {
		// Publish before the write transaction; GC takes the same asset lock.
		if err := s.blobs.PublishAsset(asset.SHA256, mediaType, content); err != nil {
			return err
		}
		count, err := sqlc.New(s.writer).AssetsInsert(ctx, sqlc.AssetsInsertParams{
			UserID: userID, Sha256: asset.SHA256, MediaType: mediaType, Size: asset.Size,
			Width: asset.Width, Height: asset.Height, CreatedAt: time.Now().UnixMilli(),
		})
		if err != nil {
			return fmt.Errorf("register annotation asset: %w", err)
		}
		inserted = count == 1
		return nil
	})
	return asset, inserted, err
}

func (s *Service) Open(ctx context.Context, userID int64, hash string) (Asset, *os.File, error) {
	if !blobstore.ValidHash(hash) {
		return Asset{}, nil, ErrInvalidHash
	}
	row, err := sqlc.New(s.reader).AssetsGetOwned(ctx, sqlc.AssetsGetOwnedParams{UserID: userID, Sha256: hash})
	if errors.Is(err, sql.ErrNoRows) {
		return Asset{}, nil, ErrNotFound
	}
	if err != nil {
		return Asset{}, nil, fmt.Errorf("get annotation asset: %w", err)
	}
	file, err := s.blobs.OpenAsset(row.Sha256, row.MediaType)
	if err != nil {
		return Asset{}, nil, fmt.Errorf("open annotation asset: %w", err)
	}
	return Asset{SHA256: row.Sha256, MediaType: row.MediaType, Size: row.Size, Width: row.Width, Height: row.Height}, file, nil
}

// GarbageCollect bounds each run to ten batches, retaining a 24-hour upload grace.
func (s *Service) GarbageCollect(ctx context.Context) error {
	cutoff := time.Now().Add(-24 * time.Hour).UnixMilli()
	for range 10 {
		var count int
		err := s.blobs.WithAssetLock(ctx, func() error {
			deleted, err := sqlc.New(s.writer).AssetsDeleteUnused(ctx, sqlc.AssetsDeleteUnusedParams{
				Cutoff: cutoff, BatchSize: 100,
			})
			if err != nil {
				return fmt.Errorf("delete unused annotation assets: %w", err)
			}
			count = len(deleted)
			for _, row := range deleted {
				owned, err := sqlc.New(s.writer).AssetsHasOwners(ctx, row.Sha256)
				if err != nil {
					return fmt.Errorf("check remaining asset owners: %w", err)
				}
				if owned {
					continue
				}
				if err := s.blobs.WithPublicationLock(ctx, func() error {
					return s.blobs.RemoveAsset(row.Sha256, row.MediaType)
				}); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
		if count < 100 {
			return nil
		}
	}
	return nil
}
