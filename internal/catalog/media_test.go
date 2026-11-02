package catalog

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"strings"
	"sync"
	"testing"

	"pandalibrary/internal/covers"
)

func testCoverPNG(t *testing.T, fill color.RGBA) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 24, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 24; x++ {
			picture.SetRGBA(x, y, fill)
		}
	}
	var result bytes.Buffer
	if err := png.Encode(&result, picture); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func TestCoverPublicationRollbackAndConcurrentUploads(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	first := testCoverPNG(t, color.RGBA{R: 220, G: 20, B: 30, A: 255})
	second := testCoverPNG(t, color.RGBA{R: 30, G: 20, B: 220, A: 255})
	normalizedFirst, err := covers.Normalize(first)
	if err != nil {
		t.Fatal(err)
	}
	normalizedSecond, err := covers.Normalize(second)
	if err != nil {
		t.Fatal(err)
	}
	var previousHash string
	if err := fixture.db.Reader.QueryRowContext(ctx, `SELECT cover_sha256 FROM books WHERE id = 101`).Scan(&previousHash); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		CREATE TRIGGER fail_cover_update BEFORE UPDATE OF cover_sha256 ON books
		WHEN OLD.id = 101 BEGIN SELECT RAISE(ABORT, 'forced cover failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.UpdateCover(ctx, admin, 101, "upload", first); err == nil || !strings.Contains(err.Error(), "forced cover failure") {
		t.Fatalf("injected cover error = %v", err)
	}
	var storedHash string
	if err := fixture.db.Reader.QueryRowContext(ctx, `SELECT cover_sha256 FROM books WHERE id = 101`).Scan(&storedHash); err != nil || storedHash != previousHash {
		t.Fatalf("cover after rollback = %q, %v; want %q", storedHash, err, previousHash)
	}
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM book_field_sources WHERE book_id = 101 AND field = 'cover'`, 0)
	for _, thumbnail := range []bool{false, true} {
		file, err := fixture.store.OpenCover(normalizedFirst.FullSHA256, thumbnail)
		if err != nil {
			t.Fatalf("published blob after rollback: %v", err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `DROP TRIGGER fail_cover_update`); err != nil {
		t.Fatal(err)
	}
	const workers = 8
	results := make(chan error, workers)
	var wait sync.WaitGroup
	for index := range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			content := first
			if index%2 != 0 {
				content = second
			}
			_, err := fixture.service.UpdateCover(ctx, admin, 101, "upload", content)
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Errorf("concurrent cover update: %v", err)
		}
	}
	var source string
	if err := fixture.db.Reader.QueryRowContext(ctx, `SELECT cover_sha256, cover_source FROM books WHERE id = 101`).
		Scan(&storedHash, &source); err != nil {
		t.Fatal(err)
	}
	if storedHash != normalizedFirst.FullSHA256 && storedHash != normalizedSecond.FullSHA256 || source != "upload" {
		t.Fatalf("committed cover = %q, %q", storedHash, source)
	}
	assertCount(t, fixture.db.Reader, `SELECT count(*) FROM book_field_sources
		WHERE book_id = 101 AND field = 'cover' AND source = 'manual' AND chosen_by = 1`, 1)
	for _, hash := range []string{normalizedFirst.FullSHA256, normalizedSecond.FullSHA256} {
		for _, thumbnail := range []bool{false, true} {
			file, err := fixture.store.OpenCover(hash, thumbnail)
			if err != nil {
				t.Fatalf("missing concurrent upload variant: %v", err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
		}
	}
}
