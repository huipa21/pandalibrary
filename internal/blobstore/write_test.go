package blobstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pandalibrary/internal/extract"
)

func TestStageBookDigestsAndPublication(t *testing.T) {
	for _, size := range []int{1, 1024, 1025, 8193, 1048577} {
		data := bytes.Repeat([]byte("abcdefg"), size/7+1)[:size]
		store, err := New(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		staged, err := store.StageBook(context.Background(), io.LimitReader(bytes.NewReader(data), int64(size)))
		if err != nil {
			t.Fatal(err)
		}
		want, err := extract.PartialMD5(bytes.NewReader(data), int64(size))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		if staged.KOReaderMD5 != want || staged.SHA256 != hex.EncodeToString(sum[:]) || staged.Size != int64(size) {
			t.Fatalf("bad staged digests: %+v, want MD5 %s", staged, want)
		}
		for range 2 {
			if err := store.PublishBook(context.Background(), staged, "epub"); err != nil {
				t.Fatal(err)
			}
		}
		if err := store.RemoveStaged(staged.Token); err != nil {
			t.Fatal(err)
		}
		file, err := store.OpenBook(staged.SHA256, "epub")
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(file)
		if closeErr := file.Close(); err != nil || closeErr != nil || !bytes.Equal(got, data) {
			t.Fatalf("published data: %v, %v", err, closeErr)
		}
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }

func TestStageBookCleanupAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	store, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, reader := range []io.Reader{failingReader{}, strings.NewReader("")} {
		if _, err := store.StageBook(context.Background(), reader); err == nil {
			t.Fatal("expected staging error")
		}
	}
	entries, err := os.ReadDir(filepath.Join(dir, "tmp"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("temporary files: %v, %v", entries, err)
	}
	staged, err := store.StageBook(context.Background(), strings.NewReader("book"))
	if err != nil {
		t.Fatal(err)
	}
	name, _ := BookPath(staged.SHA256, "pdf")
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte("other"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.PublishBook(context.Background(), staged, "pdf"); err == nil {
		t.Fatal("overwrote different blob")
	}
	forged := staged
	forged.SHA256 = strings.Repeat("a", 64)
	if err := store.PublishBook(context.Background(), forged, "epub"); err == nil {
		t.Fatal("published content under a forged hash")
	}
	forgedPath, _ := BookPath(forged.SHA256, "epub")
	if _, err := os.Stat(filepath.Join(dir, forgedPath)); !os.IsNotExist(err) {
		t.Fatalf("forged blob left behind: %v", err)
	}
	if err := store.PublishBook(context.Background(), staged, "../pdf"); !errors.Is(err, ErrInvalidKey) {
		t.Fatal(err)
	}
	if _, err := store.OpenStaged("../escape"); !errors.Is(err, ErrInvalidKey) {
		t.Fatal(err)
	}
	if err := store.RemoveStaged(staged.Token); err != nil {
		t.Fatal(err)
	}
}

func TestPublishBookCancellation(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	staged, err := store.StageBook(context.Background(), strings.NewReader("book"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := store.PublishBook(ctx, staged, "epub"); !errors.Is(err, context.Canceled) {
		t.Fatalf("publish cancellation: %v", err)
	}
	if _, err := store.OpenBook(staged.SHA256, "epub"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancelled blob published: %v", err)
	}
	if err := store.RemoveStaged(staged.Token); err != nil {
		t.Fatal(err)
	}
}
