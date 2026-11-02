package blobstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestBlobPathsAndMediaTypes(t *testing.T) {
	hash := strings.Repeat("a", 64)
	for format, wantType := range map[string]string{
		"epub": "application/epub+zip", "pdf": "application/pdf",
		"mobi": "application/x-mobipocket-ebook", "azw3": "application/vnd.amazon.ebook",
		"fb2": "application/x-fictionbook+xml", "fbz": "application/zip", "cbz": "application/vnd.comicbook+zip",
	} {
		gotType, err := ContentType(format)
		if err != nil || gotType != wantType || strings.Contains(gotType, "text/html") {
			t.Errorf("%s MIME = %q, %v", format, gotType, err)
		}
		name, err := BookPath(hash, format)
		if err != nil || name != filepath.Join("files", "aa", hash+"."+format) {
			t.Errorf("%s path = %q, %v", format, name, err)
		}
	}
	for _, invalid := range []string{"", strings.Repeat("A", 64), strings.Repeat("g", 64), "../escape", strings.Repeat("a", 63)} {
		if ValidHash(invalid) {
			t.Errorf("accepted invalid hash %q", invalid)
		}
		if _, err := BookPath(invalid, "epub"); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("book hash %q error = %v", invalid, err)
		}
		if _, err := CoverPath(invalid, false); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("cover hash %q error = %v", invalid, err)
		}
	}
	for _, format := range []string{"", "html", "EPUB", "../pdf", "pdf/escape", `pdf\escape`} {
		if _, err := BookPath(hash, format); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("format %q error = %v", format, err)
		}
	}
	for _, test := range []struct {
		thumbnail bool
		suffix    string
	}{
		{false, ".jpg"}, {true, "-w400.jpg"},
	} {
		name, err := CoverPath(hash, test.thumbnail)
		if err != nil || name != filepath.Join("covers", "aa", hash+test.suffix) {
			t.Errorf("cover path = %q, %v", name, err)
		}
	}
}

func TestPublishCoverConcurrentAndExistingContent(t *testing.T) {
	root := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	full := []byte("normalized full cover")
	thumbnail := []byte("normalized thumbnail")
	sum := sha256.Sum256(full)
	hash := hex.EncodeToString(sum[:])
	const workers = 24
	errorsFound := make(chan error, workers)
	var wait sync.WaitGroup
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			errorsFound <- store.PublishCover(hash, full, thumbnail)
		}()
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Errorf("concurrent publication: %v", err)
		}
	}
	for _, test := range []struct {
		thumbnail bool
		want      []byte
	}{
		{false, full}, {true, thumbnail},
	} {
		file, err := store.OpenCover(hash, test.thumbnail)
		if err != nil {
			t.Fatal(err)
		}
		got, readErr := io.ReadAll(file)
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || !bytes.Equal(got, test.want) {
			t.Fatalf("read cover = %q, %v, %v; want %q", got, readErr, closeErr, test.want)
		}
	}
	entries, err := os.ReadDir(filepath.Join(root, "tmp"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("staging files = %v, %v", entries, err)
	}
	if err := store.PublishCover(hash, []byte("different full"), thumbnail); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("mismatched hash error = %v", err)
	}
	if err := store.PublishCover(hash, full, []byte("different thumbnail")); err == nil {
		t.Fatal("existing thumbnail was not verified")
	}
	thumbPath, err := CoverPath(hash, true)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(root, thumbPath))
	if err != nil || !bytes.Equal(got, thumbnail) {
		t.Fatalf("existing thumbnail was modified: %q, %v", got, err)
	}
}

func TestBlobReadsCannotEscapeRoot(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a", 64)
	if err := os.MkdirAll(filepath.Join(root, "files"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, hash+".epub"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "files", "aa")
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS != "windows" {
			t.Fatal(err)
		}
		quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
		script := fmt.Sprintf("New-Item -ItemType Junction -Path %s -Target %s -ErrorAction Stop | Out-Null", quote(link), quote(outside))
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		output, junctionErr := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script).CombinedOutput()
		cancel()
		if junctionErr != nil {
			t.Skipf("symlink and junction creation unavailable: %v; %v: %s", err, junctionErr, output)
		}
	}
	t.Cleanup(func() {
		if err := os.Remove(link); err != nil {
			t.Errorf("remove test link: %v", err)
		}
	})
	file, err := store.OpenBook(hash, "epub")
	if err == nil {
		if err := file.Close(); err != nil {
			t.Error(err)
		}
		t.Fatal("opened a blob outside the data root")
	}
}
