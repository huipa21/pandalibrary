package blobstore

import (
	"context"
	"crypto/md5"
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

	"pandalibrary/internal/extract"
)

type StagedBook struct {
	Token       string `json:"token"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	KOReaderMD5 string `json:"koreader_md5"`
}

var ErrEmptyBook = errors.New("empty book file")

func stagePath(token string) (string, error) {
	if len(token) != 32 || strings.ToLower(token) != token {
		return "", ErrInvalidKey
	}
	if _, err := hex.DecodeString(token); err != nil {
		return "", ErrInvalidKey
	}
	return filepath.Join("tmp", "book-"+token), nil
}

func (s *Store) StageBook(ctx context.Context, reader io.Reader) (staged StagedBook, returnErr error) {
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return staged, err
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	if err := root.MkdirAll("tmp", 0o750); err != nil {
		return staged, err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return staged, err
	}
	staged.Token = hex.EncodeToString(random[:])
	name, _ := stagePath(staged.Token)
	file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return staged, err
	}
	defer func() {
		if returnErr != nil {
			returnErr = errors.Join(returnErr, root.Remove(name))
		}
	}()
	sha := sha256.New()
	partial := md5.New()
	buffer := make([]byte, 64*1024)
	for {
		if err := ctx.Err(); err != nil {
			return staged, errors.Join(err, file.Close())
		}
		count, readErr := reader.Read(buffer)
		if count > 0 {
			chunk := buffer[:count]
			for sample := 0; sample < extract.PartialMD5MaxSamples; sample++ {
				offset := int64(0)
				if sample > 0 {
					offset = int64(extract.PartialMD5SampleSize) << (2 * (sample - 1))
				}
				start := max(offset, staged.Size)
				end := min(offset+extract.PartialMD5SampleSize, staged.Size+int64(count))
				if start < end {
					_, _ = partial.Write(chunk[start-staged.Size : end-staged.Size])
				}
			}
			if _, err := io.MultiWriter(file, sha).Write(chunk); err != nil {
				return staged, errors.Join(err, file.Close())
			}
			staged.Size += int64(count)
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				return staged, errors.Join(readErr, file.Close())
			}
			break
		}
	}
	if err := errors.Join(file.Sync(), file.Close()); err != nil {
		return staged, err
	}
	if staged.Size == 0 {
		return staged, ErrEmptyBook
	}
	staged.SHA256 = hex.EncodeToString(sha.Sum(nil))
	staged.KOReaderMD5 = hex.EncodeToString(partial.Sum(nil))
	return staged, nil
}

func (s *Store) OpenStaged(token string) (*os.File, error) {
	name, err := stagePath(token)
	if err != nil {
		return nil, err
	}
	return s.open(name)
}

func (s *Store) RemoveStaged(token string) (returnErr error) {
	name, err := stagePath(token)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	if err := root.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func (s *Store) PublishBook(ctx context.Context, staged StagedBook, format string) (returnErr error) {
	select {
	case s.publication <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-s.publication }()
	name, err := BookPath(staged.SHA256, format)
	if err != nil {
		return err
	}
	temporary, err := stagePath(staged.Token)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(s.root)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	if err := root.MkdirAll(filepath.Dir(name), 0o750); err != nil {
		return err
	}
	if err := verifyBook(ctx, root, temporary, staged); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := root.Link(temporary, name); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return verifyBook(ctx, root, name, staged)
		}
		return fmt.Errorf("publish book: %w", err)
	}
	return nil
}

func verifyBook(ctx context.Context, root *os.Root, name string, staged StagedBook) error {
	info, err := root.Lstat(name)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || staged.Size <= 0 || info.Size() != staged.Size {
		return errors.New("book is not regular staged content")
	}
	file, err := root.Open(name)
	if err != nil {
		return err
	}
	hash := sha256.New()
	size, readErr := io.Copy(hash, contextReader{context: ctx, reader: file})
	if err := errors.Join(readErr, file.Close()); err != nil {
		return err
	}
	if size != staged.Size || hex.EncodeToString(hash.Sum(nil)) != staged.SHA256 {
		return errors.New("existing book differs from staged content")
	}
	return nil
}

type contextReader struct {
	context context.Context
	reader  io.Reader
}

func (reader contextReader) Read(buffer []byte) (int, error) {
	if err := reader.context.Err(); err != nil {
		return 0, err
	}
	return reader.reader.Read(buffer)
}
