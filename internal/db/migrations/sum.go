package migrations

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var migrationNamePattern = regexp.MustCompile(`^[a-z0-9]+(_[a-z0-9]+)*$`)

// GenerateSum rewrites migrations.sum from versioned migration files in dir.
func GenerateSum(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("list migration directory: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && migrationFilePattern.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		return fmt.Errorf("no versioned migration files found in %q", dir)
	}

	var lines []string
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("read migration %q: %w", name, err)
		}
		lines = append(lines, fmt.Sprintf("%x  %s", sha256.Sum256(data), name))
	}
	content := strings.Join(lines, "\n") + "\n"
	path := filepath.Join(dir, "migrations.sum")
	temporary, err := os.CreateTemp(dir, "migrations.sum-*")
	if err != nil {
		return fmt.Errorf("create temporary sum file: %w", err)
	}
	temporaryPath := temporary.Name()
	if _, err := temporary.WriteString(content); err != nil {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("write temporary sum file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("close temporary sum file: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		_ = os.Remove(temporaryPath)
		return fmt.Errorf("replace migrations.sum: %w", err)
	}
	return nil
}

// CreateSQLMigration creates the next sequential SQL migration in dir.
func CreateSQLMigration(dir, name string) (string, error) {
	if !migrationNamePattern.MatchString(name) {
		return "", fmt.Errorf("invalid migration name %q; use lowercase words separated by underscores", name)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", fmt.Errorf("list migration directory: %w", err)
	}
	var versions []int
	for _, entry := range entries {
		match := migrationFilePattern.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		var version int
		if _, err := fmt.Sscanf(match[1], "%d", &version); err != nil {
			return "", fmt.Errorf("parse migration version from %q: %w", entry.Name(), err)
		}
		versions = append(versions, version)
	}
	sort.Ints(versions)
	for i, version := range versions {
		if version != i+1 {
			return "", fmt.Errorf("cannot create migration: version sequence has a gap at %05d", i+1)
		}
	}
	version := len(versions) + 1
	filename := fmt.Sprintf("%05d_%s.sql", version, name)
	path := filepath.Join(dir, filename)
	content := "-- +goose Up\n\n-- TODO: implement migration.\n\n-- +goose Down\n\n-- TODO: revert migration.\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("create migration %q: %w", filename, err)
	}
	return path, nil
}
