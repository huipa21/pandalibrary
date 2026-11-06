package bookheap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"pandalibrary/internal/covers"
	"pandalibrary/internal/extract"
)

var errNotRegular = errors.New("not a regular file")

// supportedExtensions are the file extensions of formats the extract registry sniffs.
var supportedExtensions = map[string]bool{
	".epub": true, ".pdf": true, ".mobi": true, ".azw": true, ".azw3": true,
	".fb2": true, ".fbz": true, ".cbz": true,
}

func supportedExtension(name string) bool {
	return supportedExtensions[strings.ToLower(path.Ext(name))]
}

// validRelPath reports whether rel is a slash-separated local path whose
// components are neither empty nor dot-prefixed.
func validRelPath(rel string) bool {
	if rel == "" || strings.ContainsRune(rel, '\\') || !utf8.ValidString(rel) || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return false
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.ContainsFunc(part, unicode.IsControl) {
			return false
		}
	}
	return true
}

func native(rel string) string { return filepath.FromSlash(rel) }

// lstatRegular verifies that every parent of rel is a real directory (not a
// symlink) and that rel itself is a regular file, without following links.
func lstatRegular(root *os.Root, rel string) (fs.FileInfo, error) {
	if !validRelPath(rel) {
		return nil, fmt.Errorf("%w: invalid heap path", fs.ErrNotExist)
	}
	parts := strings.Split(rel, "/")
	for index := 1; index < len(parts); index++ {
		info, err := root.Lstat(native(strings.Join(parts[:index], "/")))
		if err != nil {
			return nil, err
		}
		if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
			return nil, errNotRegular
		}
	}
	info, err := root.Lstat(native(rel))
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errNotRegular
	}
	return info, nil
}

// openRegular opens rel only if it is, and stays, the regular file seen by Lstat.
func openRegular(root *os.Root, rel string) (*os.File, fs.FileInfo, error) {
	before, err := lstatRegular(root, rel)
	if err != nil {
		return nil, nil, err
	}
	file, err := root.Open(native(rel))
	if err != nil {
		return nil, nil, err
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return nil, nil, errors.Join(errNotRegular, err, file.Close())
	}
	return file, after, nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}

func hashFile(ctx context.Context, file io.Reader) (string, int64, error) {
	hash := sha256.New()
	size, err := io.CopyBuffer(hash, contextReader{ctx: ctx, reader: file}, make([]byte, 64<<10))
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

// analysis is the extracted, storable description of one heap file.
type analysis struct {
	format      string
	title       string
	authors     []string
	language    string
	series      string
	seriesIndex *float64
	cover       string
	invalid     bool
	problem     string
}

// analyze sniffs and extracts a file. Unsupported or corrupt content yields an
// invalid analysis; metadata and cover failures are recorded in problem. Only
// cancellation and storage failures are returned as errors.
func (s *Service) analyze(ctx context.Context, file io.ReaderAt, size int64, name string) (analysis, error) {
	result := analysis{title: fallbackTitle(name)}
	format, err := extract.Sniff(file, size)
	if err != nil {
		result.invalid = true
		result.problem = s.safeError(err)
		return result, nil
	}
	result.format = string(format)
	metadata, err := s.registry.Extract(ctx, file, size, name)
	if ctxErr := ctx.Err(); ctxErr != nil {
		return result, ctxErr
	}
	if err != nil {
		result.problem = "metadata extraction failed: " + s.safeError(err)
		return result, nil
	}
	if title := clean(metadata.Title, 1000); title != "" {
		result.title = title
	}
	seen := map[string]bool{}
	for _, author := range metadata.Authors {
		name := clean(author.Name, 300)
		if name == "" || seen[strings.ToLower(name)] || len(result.authors) >= 50 {
			continue
		}
		seen[strings.ToLower(name)] = true
		result.authors = append(result.authors, name)
	}
	if metadata.Language != nil {
		result.language = clean(*metadata.Language, 64)
	}
	if metadata.Series != nil {
		result.series = clean(*metadata.Series, 500)
		if result.series != "" && metadata.SeriesIndex != nil {
			index := *metadata.SeriesIndex
			result.seriesIndex = &index
		}
	}
	if len(metadata.Cover) > 0 {
		normalized, err := covers.Normalize(metadata.Cover)
		if err != nil {
			result.problem = "cover could not be read: " + s.safeError(err)
			return result, nil
		}
		if err := s.blobs.PublishCover(normalized.FullSHA256, normalized.FullJPEG, normalized.ThumbnailJPEG); err != nil {
			return result, fmt.Errorf("publish heap cover: %w", err)
		}
		result.cover = normalized.FullSHA256
	}
	return result, nil
}

func clean(value string, limit int) string {
	value = strings.Join(strings.FieldsFunc(value, func(char rune) bool {
		return unicode.IsSpace(char) || unicode.IsControl(char)
	}), " ")
	if len(value) > limit {
		value = strings.TrimSpace(strings.ToValidUTF8(value[:limit], ""))
	}
	return value
}

// fallbackTitle mirrors the importer: the file name without its extension.
func fallbackTitle(name string) string {
	title := strings.TrimSuffix(name, path.Ext(name))
	title = strings.Join(strings.Fields(strings.NewReplacer("_", " ", ".", " ").Replace(title)), " ")
	title = clean(title, 1000)
	if title == "" {
		return "Untitled"
	}
	return title
}

var reservedWindowsNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true, "COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true, "LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// sanitizeStem turns an uploaded file name into a safe, visible base name.
func sanitizeStem(name string) string {
	stem := strings.TrimSuffix(name, path.Ext(name))
	stem = strings.Map(func(char rune) rune {
		if unicode.IsControl(char) || strings.ContainsRune(`/\:<>"|?*`, char) {
			return '_'
		}
		return char
	}, stem)
	stem = strings.Trim(stem, ". ")
	if len(stem) > 180 {
		stem = strings.TrimRight(strings.ToValidUTF8(stem[:180], ""), ". ")
	}
	if stem == "" {
		stem = "book"
	}
	if reservedWindowsNames[strings.ToUpper(stem)] {
		stem += "_"
	}
	return stem
}
