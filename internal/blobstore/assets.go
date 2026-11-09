package blobstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// WithAssetLock serializes asset publication plus ownership registration with GC.
// Callbacks may publish assets, but must not acquire this lock recursively.
func (s *Store) WithAssetLock(ctx context.Context, run func() error) error {
	select {
	case s.assets <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-s.assets }()
	if err := ctx.Err(); err != nil {
		return err
	}
	return run()
}

// AssetPath returns the confined content-addressed image path.
func AssetPath(hash, mediaType string) (string, error) {
	if !ValidHash(hash) {
		return "", fmt.Errorf("%w: invalid asset hash", ErrInvalidKey)
	}
	var extension string
	switch mediaType {
	case "image/png":
		extension = "png"
	case "image/jpeg":
		extension = "jpg"
	case "image/webp":
		extension = "webp"
	default:
		return "", fmt.Errorf("%w: unsupported asset media type", ErrInvalidKey)
	}
	return filepath.Join("assets", hash[:2], hash+"."+extension), nil
}

func (s *Store) OpenAsset(hash, mediaType string) (*os.File, error) {
	name, err := AssetPath(hash, mediaType)
	if err != nil {
		return nil, err
	}
	return s.open(name)
}

// PublishAsset verifies existing bytes rather than replacing content.
func (s *Store) PublishAsset(hash, mediaType string, content []byte) error {
	name, err := AssetPath(hash, mediaType)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(content)
	if len(content) == 0 || hex.EncodeToString(sum[:]) != hash {
		return fmt.Errorf("%w: asset content does not match its key", ErrInvalidKey)
	}
	return s.WithPublicationLock(context.Background(), func() (returnErr error) {
		root, err := os.OpenRoot(s.root)
		if err != nil {
			return fmt.Errorf("open asset root: %w", err)
		}
		defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
		for _, directory := range []string{filepath.Dir(name), "tmp"} {
			if err := root.MkdirAll(directory, 0o750); err != nil {
				return fmt.Errorf("create asset directory: %w", err)
			}
		}
		if err := publish(root, name, content); err != nil {
			return fmt.Errorf("publish asset: %w", err)
		}
		now := time.Now()
		if err := root.Chtimes(name, now, now); err != nil {
			return fmt.Errorf("refresh asset grace: %w", err)
		}
		return nil
	})
}

// RemoveAsset tolerates an already absent blob.
func (s *Store) RemoveAsset(hash, mediaType string) (returnErr error) {
	name, err := AssetPath(hash, mediaType)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return fmt.Errorf("open asset root: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	if err := root.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove asset: %w", err)
	}
	return nil
}
