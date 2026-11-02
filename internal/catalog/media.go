package catalog

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"time"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/covers"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

// Content is an authorized, open file and the metadata needed to serve it.
type Content struct {
	File        *os.File
	Filename    string
	ContentType string
	ETag        string
	ModTime     time.Time
	Immutable   bool
}

// CoverUpdate identifies the normalized cover stored for a book.
type CoverUpdate struct {
	CoverSHA256 string `json:"cover_sha256"`
	CoverSource string `json:"cover_source"`
}

// CheckVisible verifies a book is accessible without returning its metadata.
func (s *Service) CheckVisible(ctx context.Context, viewer Viewer, bookID int64) error {
	if err := checkViewer(viewer); err != nil {
		return err
	}
	if bookID < 1 {
		return invalid("book ID is invalid")
	}
	_, err := visibleBook(ctx, sqlc.New(s.reader), viewer, bookID)
	return err
}

// OpenBookFile opens a visible book's file and verifies its optional hash version.
func (s *Service) OpenBookFile(ctx context.Context, viewer Viewer, bookID, fileID int64, version string) (Content, error) {
	if err := checkViewer(viewer); err != nil {
		return Content{}, err
	}
	if bookID < 1 || fileID < 1 {
		return Content{}, invalid("book and file IDs must be positive")
	}
	if version != "" && !blobstore.ValidHash(version) {
		return Content{}, invalid("file version is invalid")
	}
	row, err := sqlc.New(s.reader).CatalogBookFile(ctx, sqlc.CatalogBookFileParams{
		BookID: bookID, FileID: fileID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return Content{}, notFound(fmt.Errorf("get visible book file: %w", err))
	}
	if version != "" && version != row.Sha256 {
		return Content{}, ErrNotFound
	}
	contentType, err := blobstore.ContentType(row.Format)
	if err != nil {
		return Content{}, fmt.Errorf("invalid stored book format: %w", err)
	}
	file, err := s.blobs.OpenBook(row.Sha256, row.Format)
	if errors.Is(err, fs.ErrNotExist) {
		return Content{}, ErrNotFound
	}
	if err != nil {
		return Content{}, fmt.Errorf("open book file: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		return Content{}, errors.Join(fmt.Errorf("stat book file: %w", err), file.Close())
	}
	if info.Size() != row.SizeBytes {
		return Content{}, errors.Join(errors.New("stored book file size does not match the catalog"), file.Close())
	}
	return Content{
		File: file, Filename: row.OriginalFilename, ContentType: contentType, ETag: row.Sha256,
		ModTime: utcMillis(row.CreatedAt), Immutable: version != "",
	}, nil
}

// OpenCover opens the full cover or thumbnail for a visible book.
func (s *Service) OpenCover(ctx context.Context, viewer Viewer, bookID int64, thumbnail bool) (Content, error) {
	if err := checkViewer(viewer); err != nil {
		return Content{}, err
	}
	if bookID < 1 {
		return Content{}, invalid("book ID is invalid")
	}
	row, err := visibleBook(ctx, sqlc.New(s.reader), viewer, bookID)
	if err != nil {
		return Content{}, err
	}
	if !row.CoverSha256.Valid {
		return Content{}, ErrNotFound
	}
	file, err := s.blobs.OpenCover(row.CoverSha256.String, thumbnail)
	if errors.Is(err, fs.ErrNotExist) {
		return Content{}, ErrNotFound
	}
	if err != nil {
		return Content{}, fmt.Errorf("open book cover: %w", err)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return Content{}, errors.Join(fmt.Errorf("hash cover: %w", err), file.Close())
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if !thumbnail && digest != row.CoverSha256.String {
		return Content{}, errors.Join(errors.New("stored cover does not match its catalog hash"), file.Close())
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return Content{}, errors.Join(fmt.Errorf("rewind cover: %w", err), file.Close())
	}
	return Content{
		File: file, Filename: "cover.jpg", ContentType: "image/jpeg",
		ETag: digest, ModTime: utcMillis(row.UpdatedAt),
	}, nil
}

// UpdateCover normalizes and publishes a cover before updating the visible book.
func (s *Service) UpdateCover(ctx context.Context, viewer Viewer, bookID int64, source string, image []byte) (CoverUpdate, error) {
	if err := checkAdmin(viewer); err != nil {
		return CoverUpdate{}, err
	}
	if bookID < 1 {
		return CoverUpdate{}, invalid("book ID is invalid")
	}
	if source != "upload" && source != "pdfjs" {
		return CoverUpdate{}, invalid("cover source is invalid")
	}
	if err := s.CheckVisible(ctx, viewer, bookID); err != nil {
		return CoverUpdate{}, err
	}
	if len(image) > covers.MaxInputBytes {
		return CoverUpdate{}, ErrTooLarge
	}
	normalized, err := covers.Normalize(image)
	if errors.Is(err, covers.ErrImageTooLarge) {
		return CoverUpdate{}, ErrTooLarge
	}
	if errors.Is(err, covers.ErrInvalidImage) {
		return CoverUpdate{}, invalid("cover image is invalid")
	}
	if err != nil {
		return CoverUpdate{}, fmt.Errorf("normalize cover: %w", err)
	}
	if err := s.blobs.PublishCover(normalized.FullSHA256, normalized.FullJPEG, normalized.ThumbnailJPEG); err != nil {
		return CoverUpdate{}, fmt.Errorf("publish cover: %w", err)
	}
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if _, err := visibleBook(ctx, queries, viewer, bookID); err != nil {
			return err
		}
		now := s.now().UnixMilli()
		if err := queries.CatalogUpdateCover(ctx, sqlc.CatalogUpdateCoverParams{
			ID: bookID, CoverSha256: sql.NullString{String: normalized.FullSHA256, Valid: true},
			CoverSource: sql.NullString{String: source, Valid: true}, UpdatedAt: now,
		}); err != nil {
			return fmt.Errorf("update book cover: %w", err)
		}
		return setManualSource(ctx, queries, viewer, bookID, "cover", now)
	})
	if err != nil {
		return CoverUpdate{}, err
	}
	return CoverUpdate{CoverSHA256: normalized.FullSHA256, CoverSource: source}, nil
}
