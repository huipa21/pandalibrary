package blobstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var ErrInvalidKey = errors.New("invalid blob key")

// Store reads content-addressed files under one data directory.
type Store struct {
	root        string
	publication chan struct{}
	assets      chan struct{}
}

// WithPublicationLock serializes orphan removal with content publication.
// The callback must not call another method that publishes content.
func (s *Store) WithPublicationLock(ctx context.Context, run func() error) error {
	select {
	case s.publication <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-s.publication }()
	if err := ctx.Err(); err != nil {
		return err
	}
	return run()
}

// New opens an existing data directory as the root of the blob layout.
func New(dataDir string) (*Store, error) {
	if dataDir == "" {
		return nil, errors.New("blob data directory must not be empty")
	}
	root, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("resolve blob data directory: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("stat blob data directory: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("blob data directory is not a directory")
	}
	return &Store{root: root, publication: make(chan struct{}, 1), assets: make(chan struct{}, 1)}, nil
}

// ValidHash reports whether hash is a lowercase hexadecimal SHA-256 digest.
func ValidHash(hash string) bool {
	if len(hash) != sha256.Size*2 || hash != strings.ToLower(hash) {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil
}

// ContentType returns the safe media type of a supported ebook format.
func ContentType(format string) (string, error) {
	switch format {
	case "epub":
		return "application/epub+zip", nil
	case "pdf":
		return "application/pdf", nil
	case "mobi":
		return "application/x-mobipocket-ebook", nil
	case "azw3":
		return "application/vnd.amazon.ebook", nil
	case "fb2":
		return "application/x-fictionbook+xml", nil
	case "fbz":
		return "application/zip", nil
	case "cbz":
		return "application/vnd.comicbook+zip", nil
	default:
		return "", fmt.Errorf("%w: unsupported book format", ErrInvalidKey)
	}
}

// BookPath returns the relative path of a validated book blob.
func BookPath(hash, format string) (string, error) {
	if !ValidHash(hash) {
		return "", fmt.Errorf("%w: invalid book hash", ErrInvalidKey)
	}
	if _, err := ContentType(format); err != nil {
		return "", err
	}
	return filepath.Join("files", hash[:2], hash+"."+format), nil
}

// CoverPath returns the relative path of a full cover or its 400-pixel thumbnail.
func CoverPath(hash string, thumbnail bool) (string, error) {
	if !ValidHash(hash) {
		return "", fmt.Errorf("%w: invalid cover hash", ErrInvalidKey)
	}
	name := hash
	if thumbnail {
		name += "-w400"
	}
	return filepath.Join("covers", hash[:2], name+".jpg"), nil
}

// OpenBook opens a regular book blob without permitting paths to escape the data root.
func (s *Store) OpenBook(hash, format string) (*os.File, error) {
	name, err := BookPath(hash, format)
	if err != nil {
		return nil, err
	}
	return s.open(name)
}

// OpenCover opens a regular normalized cover or thumbnail.
func (s *Store) OpenCover(hash string, thumbnail bool) (*os.File, error) {
	name, err := CoverPath(hash, thumbnail)
	if err != nil {
		return nil, err
	}
	return s.open(name)
}

func (s *Store) open(name string) (*os.File, error) {
	file, err := os.OpenInRoot(s.root, name)
	if err != nil {
		return nil, fmt.Errorf("open blob: %w", err)
	}
	info, err := file.Stat()
	if err == nil && !info.Mode().IsRegular() {
		err = errors.New("blob is not a regular file")
	}
	if err != nil {
		return nil, errors.Join(fmt.Errorf("inspect blob: %w", err), file.Close())
	}
	return file, nil
}

// PublishCover atomically publishes normalized cover variants without replacing existing blobs.
func (s *Store) PublishCover(hash string, full, thumbnail []byte) (returnErr error) {
	s.publication <- struct{}{}
	defer func() { <-s.publication }()
	fullPath, err := CoverPath(hash, false)
	if err != nil {
		return err
	}
	thumbnailPath, err := CoverPath(hash, true)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(full)
	if hex.EncodeToString(sum[:]) != hash || len(thumbnail) == 0 {
		return fmt.Errorf("%w: cover content does not match its key", ErrInvalidKey)
	}
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return fmt.Errorf("open blob root: %w", err)
	}
	defer func() {
		if err := root.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close blob root: %w", err))
		}
	}()
	if err := root.MkdirAll(filepath.Dir(fullPath), 0o750); err != nil {
		return fmt.Errorf("create cover directory: %w", err)
	}
	if err := root.MkdirAll("tmp", 0o750); err != nil {
		return fmt.Errorf("create temporary directory: %w", err)
	}
	if err := publish(root, fullPath, full); err != nil {
		return fmt.Errorf("publish full cover: %w", err)
	}
	if err := publish(root, thumbnailPath, thumbnail); err != nil {
		return fmt.Errorf("publish cover thumbnail: %w", err)
	}
	// Reusing an old orphan is a new publication too; restart its maintenance grace.
	now := time.Now()
	for _, path := range []string{fullPath, thumbnailPath} {
		if err := root.Chtimes(path, now, now); err != nil {
			return fmt.Errorf("refresh published cover grace: %w", err)
		}
	}
	return nil
}

func publish(root *os.Root, name string, content []byte) (returnErr error) {
	if err := verifyExisting(root, name, content); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return fmt.Errorf("generate temporary cover name: %w", err)
	}
	temporary := filepath.Join("tmp", "cover-"+hex.EncodeToString(random[:]))
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create temporary cover: %w", err)
	}
	defer func() {
		if err := root.Remove(temporary); err != nil && !errors.Is(err, fs.ErrNotExist) {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove temporary cover: %w", err))
		}
	}()
	written, writeErr := file.Write(content)
	if writeErr == nil && written != len(content) {
		writeErr = io.ErrShortWrite
	}
	var syncErr error
	if writeErr == nil {
		syncErr = file.Sync()
	}
	if err := errors.Join(writeErr, syncErr, file.Close()); err != nil {
		return fmt.Errorf("write temporary cover: %w", err)
	}
	if err := root.Link(temporary, name); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return verifyExisting(root, name, content)
		}
		return fmt.Errorf("publish cover link: %w", err)
	}
	return nil
}

func verifyExisting(root *os.Root, name string, expected []byte) (returnErr error) {
	file, err := root.Open(name)
	if err != nil {
		return err
	}
	defer func() {
		if err := file.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close existing cover: %w", err))
		}
	}()
	info, err := file.Stat()
	if err != nil {
		return fmt.Errorf("stat existing cover: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() != int64(len(expected)) {
		return errors.New("existing cover differs from normalized content")
	}
	actual, err := io.ReadAll(io.LimitReader(file, int64(len(expected))+1))
	if err != nil {
		return fmt.Errorf("read existing cover: %w", err)
	}
	if !bytes.Equal(actual, expected) {
		return errors.New("existing cover differs from normalized content")
	}
	return nil
}
