package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDictImportAndList(t *testing.T) {
	dataDir := t.TempDir()
	file := filepath.Join(t.TempDir(), "cedict.txt")
	if err := os.WriteFile(file, []byte("# test\n詞典 词典 [ci2 dian3] /dictionary/\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if err := run([]string{"dict", "list", "--data-dir", dataDir}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "No dictionaries imported.") {
		t.Fatalf("empty list output = %q", stdout.String())
	}
	stdout.Reset()
	if err := run([]string{"dict", "import", "--source", "cc-cedict", "--file", file, "--data-dir", dataDir}, &stdout, &stderr); err != nil {
		t.Fatalf("import: %v (stderr %q)", err, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Imported 1 cc-cedict entries") {
		t.Fatalf("import output = %q", stdout.String())
	}
	if _, err := os.Stat(filepath.Join(dataDir, "dictionaries", "dictionaries.db")); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	if err := runDict([]string{"list", "--data-dir", dataDir}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if out := stdout.String(); !strings.Contains(out, "cc-cedict") || !strings.Contains(out, "CC-CEDICT") {
		t.Fatalf("list output = %q", out)
	}
}

func TestDictRejectsBadArguments(t *testing.T) {
	var stdout, stderr bytes.Buffer
	for _, args := range [][]string{
		{},
		{"unknown"},
		{"import", "--file", "x"},
		{"import", "--source", "nope", "--file", "x", "--data-dir", t.TempDir()},
	} {
		if err := runDict(args, &stdout, &stderr); err == nil {
			t.Fatalf("runDict(%q) succeeded", args)
		}
	}
}
