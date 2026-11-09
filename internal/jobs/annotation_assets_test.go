package jobs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pandalibrary/internal/annotations"
	"pandalibrary/internal/blobstore"
)

func TestAssetUploadProtectsNewOwnerFromConcurrentGC(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	seedUserAndLibrary(t, fixture.databases.Writer)
	if _, err := fixture.databases.Writer.Exec(`INSERT INTO users
		(id, username, password_hash, role, created_at, updated_at) VALUES (2, 'second', 'x', 'user', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	content := encoded.Bytes()
	sum := sha256.Sum256(content)
	hash := hex.EncodeToString(sum[:])
	if err := fixture.service.blobs.PublishAsset(hash, "image/png", content); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-25 * time.Hour)
	if _, err := fixture.databases.Writer.Exec(`INSERT INTO annotation_assets
		(user_id, sha256, media_type, size, width, height, created_at)
		VALUES (1, ?, 'image/png', ?, 1, 1, ?)`, hash, len(content), old.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	path, err := blobstore.AssetPath(hash, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	fullPath := filepath.Join(fixture.dataDir, path)
	if err := os.Chtimes(fullPath, old, old); err != nil {
		t.Fatal(err)
	}
	service, err := annotations.NewService(fixture.databases.Writer, fixture.databases.Reader, fixture.service.blobs)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := fixture.databases.Writer.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	uploaded := make(chan error, 1)
	go func() {
		_, _, err := service.Upload(ctx, 2, "image/png", content)
		uploaded <- err
	}()
	// Hold the writer until the upload has published but cannot register its owner.
	for {
		info, err := os.Stat(fullPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.ModTime().After(old.Add(time.Hour)) {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("upload did not publish outside the write transaction")
		case <-time.After(time.Millisecond):
		}
	}
	collected := make(chan error, 1)
	go func() { collected <- service.GarbageCollect(ctx) }()
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, pending := range []chan error{uploaded, collected} {
		if err := <-pending; err != nil {
			t.Fatal(err)
		}
	}
	if _, file, err := service.Open(ctx, 2, hash); err != nil {
		t.Fatalf("GC lost concurrently uploaded shared blob: %v", err)
	} else if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAnnotationAssetsGC(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	seedUserAndLibrary(t, fixture.databases.Writer)
	if _, err := fixture.databases.Writer.Exec(`
		INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
		VALUES (2, 'second', 'x', 'user', 1, 1);
		INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		VALUES (1, 1, 'PDF', 'pdf', 1, 1)
	`); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-25 * time.Hour).UnixMilli()
	now := time.Now().UnixMilli()
	type testAsset struct {
		name       string
		created    int64
		referenced bool
		deleted    bool
		shared     bool
		keepRow    bool
		keepBlob   bool
	}
	tests := []testAsset{
		{name: "live", created: old, referenced: true, keepRow: true, keepBlob: true},
		{name: "recent", created: now, keepRow: true, keepBlob: true},
		{name: "unused", created: old},
		{name: "tombstone", created: old, referenced: true, deleted: true},
		{name: "shared", created: old, shared: true, keepBlob: true},
	}
	hashes := make(map[string]string)
	for i, test := range tests {
		content := []byte(test.name)
		sum := sha256.Sum256(content)
		hash := hex.EncodeToString(sum[:])
		hashes[test.name] = hash
		if err := fixture.service.blobs.PublishAsset(hash, "image/png", content); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.databases.Writer.Exec(`INSERT INTO annotation_assets
			(user_id, sha256, media_type, size, width, height, created_at) VALUES (1, ?, 'image/png', ?, 1, 1, ?)`,
			hash, len(content), test.created); err != nil {
			t.Fatal(err)
		}
		if test.shared {
			if _, err := fixture.databases.Writer.Exec(`INSERT INTO annotation_assets
				(user_id, sha256, media_type, size, width, height, created_at) VALUES (2, ?, 'image/png', ?, 1, 1, ?)`,
				hash, len(content), now); err != nil {
				t.Fatal(err)
			}
		}
		if test.referenced {
			var deleted any
			if test.deleted {
				deleted = old
			}
			if _, err := fixture.databases.Writer.Exec(`INSERT INTO page_annotations
				(id, user_id, book_id, kind, locator, position, data, asset_sha256, created_at, updated_at, deleted_at, rev)
				VALUES (?, 1, 1, 'image', '{}', 0, '{}', ?, 1, 1, ?, 1)`,
				fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", i), hash, deleted); err != nil {
				t.Fatal(err)
			}
		}
	}
	run := fixture.service.jobs["annotation-assets-gc"].job.run
	if err := run(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, test := range tests {
		hash := hashes[test.name]
		var exists bool
		if err := fixture.databases.Reader.QueryRow(`SELECT EXISTS(
			SELECT 1 FROM annotation_assets WHERE user_id = 1 AND sha256 = ?)`, hash).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists != test.keepRow {
			t.Errorf("%s owner exists = %v", test.name, exists)
		}
		path, err := blobstore.AssetPath(hash, "image/png")
		if err != nil {
			t.Fatal(err)
		}
		_, err = os.Stat(filepath.Join(fixture.dataDir, path))
		if test.keepBlob && err != nil || !test.keepBlob && !os.IsNotExist(err) {
			t.Errorf("%s blob: %v", test.name, err)
		}
	}
	// Once the other owner ages out, the shared blob can also be removed.
	if _, err := fixture.databases.Writer.Exec("UPDATE annotation_assets SET created_at = ? WHERE user_id = 2", old); err != nil {
		t.Fatal(err)
	}
	if err := run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if file, err := fixture.service.blobs.OpenAsset(hashes["shared"], "image/png"); !errors.Is(err, os.ErrNotExist) {
		if file != nil {
			_ = file.Close()
		}
		t.Fatalf("shared blob retained after last owner: %v", err)
	}
	// Missing blobs are tolerated, and collection crosses batch boundaries.
	for i := range 101 {
		if _, err := fixture.databases.Writer.Exec(`INSERT INTO annotation_assets
			(user_id, sha256, media_type, size, width, height, created_at)
			VALUES (1, ?, 'image/png', 1, 1, 1, ?)`, fmt.Sprintf("%064x", i), old); err != nil {
			t.Fatal(err)
		}
	}
	if err := run(context.Background()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := fixture.databases.Reader.QueryRow("SELECT count(*) FROM annotation_assets").Scan(&count); err != nil || count != 2 {
		t.Fatalf("remaining owners = %d, %v", count, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := run(ctx); err != context.Canceled {
		t.Fatalf("canceled GC = %v", err)
	}
}

func TestAssetOrphanSweepAfterDeletedAccountAndFailedPublication(t *testing.T) {
	fixture := newMaintenanceFixture(t)
	seedUserAndLibrary(t, fixture.databases.Writer)
	for i, keep := range []bool{false, true} {
		content := []byte(fmt.Sprintf("asset %d", i))
		sum := sha256.Sum256(content)
		hash := hex.EncodeToString(sum[:])
		if err := fixture.service.blobs.PublishAsset(hash, "image/webp", content); err != nil {
			t.Fatal(err)
		}
		path, err := blobstore.AssetPath(hash, "image/webp")
		if err != nil {
			t.Fatal(err)
		}
		fullPath := filepath.Join(fixture.dataDir, path)
		old := time.Now().Add(-25 * time.Hour)
		if err := os.Chtimes(fullPath, old, old); err != nil {
			t.Fatal(err)
		}
		if keep {
			if _, err := fixture.databases.Writer.Exec(`INSERT INTO annotation_assets
				(user_id, sha256, media_type, size, width, height, created_at)
				VALUES (1, ?, 'image/webp', 1, 1, 1, 1)`, hash); err != nil {
				t.Fatal(err)
			}
		}
		if err := fixture.service.sweepOrphans(context.Background()); err != nil {
			t.Fatal(err)
		}
		_, err = os.Stat(fullPath)
		if keep && err != nil || !keep && !os.IsNotExist(err) {
			t.Fatalf("keep=%v, stat=%v", keep, err)
		}
		if keep {
			if _, err := fixture.databases.Writer.Exec("DELETE FROM users WHERE id = 1"); err != nil {
				t.Fatal(err)
			}
			if err := fixture.service.sweepOrphans(context.Background()); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(fullPath); !os.IsNotExist(err) {
				t.Fatalf("deleted account orphan retained: %v", err)
			}
		}
	}
}
