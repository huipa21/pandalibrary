package webui

import (
	"io/fs"
	"testing"
)

func TestFallbackIsEmbedded(t *testing.T) {
	if _, err := fs.Stat(Files, "build/index.html"); err != nil {
		t.Fatalf("embedded SPA fallback is missing: %v", err)
	}
}
