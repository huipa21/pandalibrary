package backup

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Lock prevents serving, restoring, or CLI database changes in two processes.
type Lock struct{ file *os.File }

func Acquire(dataDir string) (*Lock, error) {
	dir := filepath.Join(dataDir, "backups")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := realDirectory(dir); err != nil {
		return nil, err
	}
	filename := filepath.Join(dir, ".application.lock")
	if info, err := os.Lstat(filename); err == nil && !info.Mode().IsRegular() {
		return nil, errors.New("application lock must be a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	file, err := os.OpenFile(filename, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(file); err != nil {
		return nil, errors.Join(fmt.Errorf("data directory is in use (stop the other PandaLibrary process): %w", err), file.Close())
	}
	return &Lock{file}, nil
}

func (l *Lock) Close() error { return l.file.Close() }
