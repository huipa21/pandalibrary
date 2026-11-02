package extract

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
)

const (
	MaxArchiveEntries       = 10_000
	MaxEntryUncompressed    = 128 << 20
	MaxArchiveUncompressed  = 512 << 20
	MaxCompressedInput      = 1 << 30
	MaxMetadataDocumentSize = 8 << 20
	MaxCoverEntrySize       = 20 << 20
)

type Archive struct {
	files map[string]*zip.File
}

func OpenArchive(r io.ReaderAt, size int64) (*Archive, error) {
	if r == nil || size <= 0 {
		return nil, fmt.Errorf("%w: empty archive", ErrInvalidInput)
	}
	if size > MaxCompressedInput {
		return nil, fmt.Errorf("%w: compressed archive is %d bytes", ErrTooLarge, size)
	}

	zr, err := zip.NewReader(r, size)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid ZIP archive: %v", ErrInvalidInput, err)
	}
	if len(zr.File) > MaxArchiveEntries {
		return nil, fmt.Errorf("%w: archive has %d entries", ErrTooLarge, len(zr.File))
	}

	files := make(map[string]*zip.File, len(zr.File))
	var total uint64
	for _, file := range zr.File {
		name, err := cleanArchivePath(file.Name)
		if err != nil {
			return nil, err
		}
		if file.Flags&1 != 0 {
			return nil, fmt.Errorf("%w: encrypted entry %q", ErrInvalidInput, file.Name)
		}
		if _, exists := files[name]; exists {
			return nil, fmt.Errorf("%w: duplicate archive path %q", ErrInvalidInput, name)
		}
		if file.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("%w: symbolic link entry %q", ErrInvalidInput, name)
		}
		if file.UncompressedSize64 > MaxEntryUncompressed {
			return nil, fmt.Errorf("%w: entry %q is too large", ErrTooLarge, name)
		}
		if file.UncompressedSize64 > MaxArchiveUncompressed-total {
			return nil, fmt.Errorf("%w: archive expands beyond %d bytes", ErrTooLarge, MaxArchiveUncompressed)
		}
		total += file.UncompressedSize64
		files[name] = file
	}

	return &Archive{files: files}, nil
}

func cleanArchivePath(name string) (string, error) {
	if name == "" || strings.ContainsRune(name, '\x00') || strings.Contains(name, `\`) ||
		strings.HasPrefix(name, "/") || (len(name) >= 2 && name[1] == ':') {
		return "", fmt.Errorf("%w: invalid archive path %q", ErrInvalidInput, name)
	}

	isDir := strings.HasSuffix(name, "/")
	trimmed := strings.TrimSuffix(name, "/")
	if trimmed == "" || path.IsAbs(trimmed) || path.Clean(trimmed) != trimmed {
		return "", fmt.Errorf("%w: invalid archive path %q", ErrInvalidInput, name)
	}
	for _, part := range strings.Split(trimmed, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("%w: invalid archive path %q", ErrInvalidInput, name)
		}
	}
	if isDir {
		return trimmed, nil
	}
	return name, nil
}

func (a *Archive) ReadFile(name string, maxSize uint64) ([]byte, error) {
	file, ok := a.files[name]
	if !ok {
		return nil, fmt.Errorf("%w: archive entry %q not found", ErrInvalidInput, name)
	}
	if file.FileInfo().IsDir() {
		return nil, fmt.Errorf("%w: archive entry %q is a directory", ErrInvalidInput, name)
	}
	if file.UncompressedSize64 > maxSize {
		return nil, fmt.Errorf("%w: entry %q exceeds its read limit", ErrTooLarge, name)
	}
	reader, err := file.Open()
	if err != nil {
		return nil, fmt.Errorf("%w: open entry %q: %v", ErrInvalidInput, name, err)
	}
	data, readErr := io.ReadAll(io.LimitReader(reader, int64(maxSize)+1))
	closeErr := reader.Close()
	if readErr != nil {
		return nil, fmt.Errorf("%w: read entry %q: %v", ErrInvalidInput, name, readErr)
	}
	if closeErr != nil && !errors.Is(closeErr, zip.ErrChecksum) {
		return nil, fmt.Errorf("%w: close entry %q: %v", ErrInvalidInput, name, closeErr)
	}
	if uint64(len(data)) != file.UncompressedSize64 {
		return nil, fmt.Errorf("%w: entry %q has an inconsistent size", ErrInvalidInput, name)
	}
	return data, nil
}

func (a *Archive) Has(name string) bool {
	_, ok := a.files[name]
	return ok
}

func (a *Archive) Names() []string {
	names := make([]string, 0, len(a.files))
	for name := range a.files {
		names = append(names, name)
	}
	return names
}

func IsLimitError(err error) bool {
	return errors.Is(err, ErrTooLarge)
}
