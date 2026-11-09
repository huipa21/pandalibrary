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
)

func TestAssetPathsPublicationAndRemoval(t *testing.T) {
	directory := t.TempDir()
	store, err := New(directory)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("asset bytes")
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	for media, extension := range map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"} {
		t.Run(extension, func(t *testing.T) {
			path, err := AssetPath(hash, media)
			if err != nil || path != filepath.Join("assets", hash[:2], hash+"."+extension) {
				t.Fatalf("path = %s, %v", path, err)
			}
			for range 2 {
				if err := store.PublishAsset(hash, media, content); err != nil {
					t.Fatal(err)
				}
			}
			file, err := store.OpenAsset(hash, media)
			if err != nil {
				t.Fatal(err)
			}
			got, readErr := io.ReadAll(file)
			if err := errors.Join(readErr, file.Close()); err != nil || !bytes.Equal(got, content) {
				t.Fatalf("read = %q, %v", got, err)
			}
			if err := os.WriteFile(filepath.Join(directory, path), []byte("corruption!"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := store.PublishAsset(hash, media, content); err == nil {
				t.Fatal("corrupt existing blob was accepted")
			}
			for range 2 {
				if err := store.RemoveAsset(hash, media); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
	for _, invalid := range []string{"../escape", strings.Repeat("A", 64), strings.Repeat("g", 64), ""} {
		if _, err := AssetPath(invalid, "image/png"); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("invalid hash = %v", err)
		}
	}
	if _, err := AssetPath(hash, "image/svg+xml"); !errors.Is(err, ErrInvalidKey) {
		t.Fatal("accepted unsafe MIME")
	}
	if err := store.PublishAsset(hash, "image/png", []byte("wrong")); !errors.Is(err, ErrInvalidKey) {
		t.Fatal("accepted mismatched hash")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := store.WithAssetLock(ctx, func() error { t.Fatal("ran canceled callback"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled lock = %v", err)
	}
}
