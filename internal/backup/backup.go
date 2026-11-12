// Package backup creates full-data archives and stages offline restores.
package backup

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/config"
	"pandalibrary/internal/db/migrations"

	_ "modernc.org/sqlite"
)

const (
	MaxArchiveBytes = int64(16 << 30)
	maxDataBytes    = int64(64 << 30)
	maxFileBytes    = int64(16 << 30)
	maxEntries      = 100000
	maxManifest     = 32 << 20
	pendingName     = ".pending-restore.tar.gz"
)

var (
	ErrInvalid  = errors.New("invalid or unsupported backup")
	ErrPending  = errors.New("a restore is already pending")
	ErrNotFound = errors.New("backup not found")
)

var roots = []string{"files", "covers", "assets", "tmp", "bookheap", "drop"}

type record struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	Version int               `json:"version"`
	Files   map[string]record `json:"files"`
}

type Info struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

// Service shares Gate with HTTP requests and all background data writers.
// Only Create takes its exclusive side; callers must not hold its read side.
type Service struct {
	DataDir string
	Dirs    map[string]string
	Writer  *sql.DB
	Gate    *sync.RWMutex
	mu      sync.Mutex
}

func New(cfg config.Config, writer *sql.DB, gate *sync.RWMutex) (*Service, error) {
	data, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	dirs := make(map[string]string)
	for _, name := range roots {
		dirs[name] = filepath.Join(data, name)
	}
	if cfg.BookheapDir != "" {
		dirs["bookheap"], err = filepath.Abs(cfg.BookheapDir)
		if err != nil {
			return nil, err
		}
	}
	if cfg.DropDir != "" {
		dirs["drop"], err = filepath.Abs(cfg.DropDir)
		if err != nil {
			return nil, err
		}
	}
	// Each managed root must be independent: replacing overlapping directories
	// could remove the database, backups, or another managed root.
	guarded := map[string]string{"data": data, "backups": filepath.Join(data, "backups")}
	for name, dir := range dirs {
		guarded[name] = dir
	}
	for name, dir := range dirs {
		for other, target := range guarded {
			if name == other {
				continue
			}
			if inside(target, dir) || other != "data" && inside(dir, target) {
				return nil, fmt.Errorf("backup requires independent managed directories: %s overlaps %s", name, other)
			}
		}
	}
	return &Service{DataDir: data, Dirs: dirs, Writer: writer, Gate: gate}, nil
}

func inside(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	return err == nil && (rel == "." || filepath.IsLocal(rel))
}

func (s *Service) directory() string { return filepath.Join(s.DataDir, "backups") }

func token() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value[:])
}

func validName(name string) bool {
	if !strings.HasPrefix(name, "full-") || !strings.HasSuffix(name, ".tar.gz") || len(name) > 100 {
		return false
	}
	for _, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '.') {
			return false
		}
	}
	return true
}

func realDirectory(dir string) error {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s must be a real directory, not a link", dir)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return err
	}
	if resolved != absolute && (runtime.GOOS != "windows" || !strings.EqualFold(resolved, absolute)) {
		return errors.New("managed directory has symlink ancestors")
	}
	return nil
}

func (s *Service) prepare() error {
	if err := os.MkdirAll(s.directory(), 0o700); err != nil {
		return err
	}
	if err := realDirectory(s.DataDir); err != nil {
		return err
	}
	return realDirectory(s.directory())
}

func (s *Service) List() ([]Info, error) {
	if err := s.prepare(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.directory())
	if err != nil {
		return nil, err
	}
	items := []Info{}
	for _, entry := range entries {
		if !validName(entry.Name()) || !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		items = append(items, Info{entry.Name(), info.Size(), info.ModTime().UTC()})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name > items[j].Name })
	return items, nil
}

func (s *Service) Open(name string) (*os.File, error) {
	if !validName(name) {
		return nil, ErrInvalid
	}
	if err := s.prepare(); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(s.directory())
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat(name)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, ErrInvalid
	}
	return root.Open(name)
}

func (s *Service) Pending() bool {
	_, err := os.Lstat(filepath.Join(s.directory(), pendingName))
	return err == nil
}

func (s *Service) PendingStatus() (bool, error) {
	_, err := os.Lstat(filepath.Join(s.directory(), pendingName))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

func (s *Service) Create(ctx context.Context) (_ Info, returnErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Gate != nil {
		s.Gate.Lock()
		defer s.Gate.Unlock()
	}
	if s.Writer == nil {
		return Info{}, errors.New("backup database is not configured")
	}
	if err := s.prepare(); err != nil {
		return Info{}, err
	}
	work, err := os.MkdirTemp(s.directory(), ".create-")
	if err != nil {
		return Info{}, err
	}
	defer func() { returnErr = errors.Join(returnErr, os.RemoveAll(work)) }()
	snapshot := filepath.Join(work, "pandalibrary.db")
	if _, err := s.Writer.ExecContext(ctx, "VACUUM INTO '"+strings.ReplaceAll(snapshot, "'", "''")+"'"); err != nil {
		return Info{}, fmt.Errorf("snapshot database: %w", err)
	}
	file, err := os.OpenFile(filepath.Join(work, "archive"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return Info{}, err
	}
	gz := gzip.NewWriter(file)
	tw := tar.NewWriter(gz)
	m := manifest{Version: 1, Files: map[string]record{}}
	var total int64
	entryCount := 0
	add := func(name string, root *os.Root, source string, info fs.FileInfo) (returnErr error) {
		if err := ctx.Err(); err != nil {
			return err
		}
		entryCount++
		if !safePath(name) || entryCount >= maxEntries || !info.Mode().IsRegular() || info.Size() > maxFileBytes {
			return fmt.Errorf("%w: unsupported file %s", ErrInvalid, name)
		}
		total += info.Size()
		if total > maxDataBytes {
			return fmt.Errorf("%w: data size limit", ErrInvalid)
		}
		input, err := root.Open(source)
		if err != nil {
			return err
		}
		defer func() { returnErr = errors.Join(returnErr, input.Close()) }()
		opened, err := input.Stat()
		if err != nil || !os.SameFile(info, opened) {
			return errors.Join(errors.New("file changed while opening backup source"), err)
		}
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: info.Size(), Typeflag: tar.TypeReg, ModTime: info.ModTime(), Format: tar.FormatPAX}); err != nil {
			return err
		}
		hash := sha256.New()
		n, err := io.CopyN(io.MultiWriter(tw, hash), contextReader{ctx, input}, info.Size())
		if err != nil {
			return err
		}
		after, err := input.Stat()
		if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
			return errors.Join(errors.New("file changed while creating backup"), err)
		}
		m.Files[name] = record{n, hex.EncodeToString(hash.Sum(nil))}
		return nil
	}
	info, err := os.Stat(snapshot)
	workRoot, rootErr := os.OpenRoot(work)
	err = errors.Join(err, rootErr)
	if err == nil {
		err = add("pandalibrary.db", workRoot, "pandalibrary.db", info)
	}
	if workRoot != nil {
		err = errors.Join(err, workRoot.Close())
	}
	for _, name := range roots {
		if err != nil {
			break
		}
		dir := s.Dirs[name]
		if err = realDirectory(dir); err != nil {
			break
		}
		storage, openErr := os.OpenRoot(dir)
		if openErr != nil {
			err = openErr
			break
		}
		err = filepath.WalkDir(dir, func(source string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			rel, err := filepath.Rel(dir, source)
			if err != nil {
				return err
			}
			archivePath := name
			if rel != "." {
				archivePath += "/" + filepath.ToSlash(rel)
			}
			if entry.IsDir() {
				entryCount++
				if !safePath(archivePath) || entryCount >= maxEntries {
					return ErrInvalid
				}
				return tw.WriteHeader(&tar.Header{Name: archivePath, Mode: 0o700, Typeflag: tar.TypeDir, Format: tar.FormatPAX})
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			return add(archivePath, storage, rel, info)
		})
		err = errors.Join(err, storage.Close())
	}
	if err == nil {
		var data []byte
		data, err = json.Marshal(m)
		if len(data) > maxManifest {
			err = ErrInvalid
		}
		if err == nil {
			err = tw.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0o600, Size: int64(len(data)), Typeflag: tar.TypeReg})
		}
		if err == nil {
			_, err = tw.Write(data)
		}
	}
	if err = errors.Join(err, tw.Close(), gz.Close(), file.Sync(), file.Close()); err != nil {
		return Info{}, err
	}
	archive := filepath.Join(work, "archive")
	if stat, err := os.Stat(archive); err != nil || stat.Size() > MaxArchiveBytes {
		return Info{}, errors.Join(ErrInvalid, err)
	}
	// Read back every entry and verify SQLite before publishing a saved backup.
	if err := s.validate(ctx, archive, filepath.Join(work, "verify")); err != nil {
		return Info{}, err
	}
	name := "full-" + time.Now().UTC().Format("20060102-150405") + "-" + token() + ".tar.gz"
	destination := filepath.Join(s.directory(), name)
	if err := os.Rename(archive, destination); err != nil {
		return Info{}, err
	}
	if err := syncDirectory(s.directory()); err != nil {
		return Info{}, err
	}
	stat, err := os.Stat(destination)
	if err != nil {
		return Info{}, err
	}
	return Info{name, stat.Size(), stat.ModTime().UTC()}, nil
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

// Stage validates and durably queues an archive; it never replaces live data.
func (s *Service) Stage(ctx context.Context, input io.Reader) (returnErr error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.prepare(); err != nil {
		return err
	}
	pending, err := s.PendingStatus()
	if err != nil {
		return err
	}
	if pending {
		return ErrPending
	}
	work, err := os.MkdirTemp(s.directory(), ".stage-")
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, os.RemoveAll(work)) }()
	archive := filepath.Join(work, "archive")
	file, err := os.OpenFile(archive, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(file, io.LimitReader(contextReader{ctx, input}, MaxArchiveBytes+1))
	if err := errors.Join(copyErr, file.Sync(), file.Close()); err != nil {
		return err
	}
	if n > MaxArchiveBytes {
		return fmt.Errorf("%w: compressed size limit", ErrInvalid)
	}
	if err := s.validate(ctx, archive, filepath.Join(work, "verify")); err != nil {
		return err
	}
	if err := os.Rename(archive, filepath.Join(s.directory(), pendingName)); err != nil {
		return err
	}
	return syncDirectory(s.directory())
}

func safePath(name string) bool {
	if len(name) > 1024 || !fs.ValidPath(name) || strings.ContainsAny(name, "\\:\x00") || strings.Count(name, "/") > 32 {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if !filepath.IsLocal(part) || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
			return false
		}
		for _, c := range part {
			if c < 32 || strings.ContainsRune("<>\"|?*", c) {
				return false
			}
		}
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
			len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9' {
			return false
		}
	}
	return true
}

func allowedPath(name string) bool {
	if name == "pandalibrary.db" || name == "manifest.json" {
		return true
	}
	top, _, _ := strings.Cut(name, "/")
	for _, root := range roots {
		if top == root {
			return true
		}
	}
	return false
}

func (s *Service) validate(ctx context.Context, archive, destination string) (returnErr error) {
	if err := os.Mkdir(destination, 0o700); err != nil {
		return err
	}
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, file.Close()) }()
	stat, err := file.Stat()
	if err != nil || stat.Size() > MaxArchiveBytes {
		return errors.Join(ErrInvalid, err)
	}
	buffered := bufio.NewReader(file)
	gz, err := gzip.NewReader(buffered)
	if err != nil {
		return fmt.Errorf("%w: gzip: %v", ErrInvalid, err)
	}
	defer gz.Close()
	gz.Multistream(false)
	limited := &io.LimitedReader{R: contextReader{ctx, gz}, N: maxDataBytes + (maxEntries * 4096) + 1}
	tr := tar.NewReader(limited)
	seen := map[string]bool{}
	canonical := map[string]string{}
	actual := map[string]record{}
	var m manifest
	var total int64
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("%w: tar: %v", ErrInvalid, err)
		}
		name := h.Name
		key := strings.ToLower(name)
		if !safePath(name) || !allowedPath(name) || seen[key] || len(seen) >= maxEntries ||
			h.Size < 0 || h.Size > maxFileBytes ||
			(h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir) {
			return fmt.Errorf("%w: unsupported archive entry", ErrInvalid)
		}
		for key := range h.PAXRecords {
			if key != "path" && key != "mtime" {
				return fmt.Errorf("%w: unsupported extended header", ErrInvalid)
			}
		}
		parts := strings.Split(name, "/")
		for i := range parts {
			component := strings.Join(parts[:i+1], "/")
			folded := strings.ToLower(component)
			if previous, ok := canonical[folded]; ok && previous != component {
				return fmt.Errorf("%w: case-colliding paths", ErrInvalid)
			}
			canonical[folded] = component
		}
		seen[key] = true
		total += h.Size
		if total > maxDataBytes {
			return fmt.Errorf("%w: expanded size limit", ErrInvalid)
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		if h.Typeflag == tar.TypeDir {
			if h.Size != 0 || name == "pandalibrary.db" || name == "manifest.json" {
				return ErrInvalid
			}
			if err := os.MkdirAll(target, 0o700); err != nil {
				return fmt.Errorf("%w: directory collision", ErrInvalid)
			}
			continue
		}
		if name == "manifest.json" {
			if h.Size > maxManifest {
				return ErrInvalid
			}
			data, err := io.ReadAll(tr)
			if err != nil || json.Unmarshal(data, &m) != nil || m.Version != 1 {
				return fmt.Errorf("%w: manifest", ErrInvalid)
			}
			continue
		}
		if path.Dir(name) == "." && name != "pandalibrary.db" {
			return ErrInvalid
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return fmt.Errorf("%w: path collision", ErrInvalid)
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		hash := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(out, hash), tr)
		if err := errors.Join(copyErr, out.Sync(), out.Close()); err != nil {
			return err
		}
		if !h.ModTime.IsZero() {
			if err := os.Chtimes(target, h.ModTime, h.ModTime); err != nil {
				return err
			}
		}
		actual[name] = record{n, hex.EncodeToString(hash.Sum(nil))}
	}
	// Consume the gzip footer too: tar EOF alone does not verify its checksum.
	padding, err := io.ReadAll(io.LimitReader(limited, (1<<20)+1))
	if err != nil || limited.N == 0 || len(padding) > 1<<20 {
		return fmt.Errorf("%w: gzip footer or trailing data", ErrInvalid)
	}
	for _, value := range padding {
		if value != 0 {
			return fmt.Errorf("%w: nonzero tar padding", ErrInvalid)
		}
	}
	if _, err := buffered.ReadByte(); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: trailing compressed data", ErrInvalid)
	}
	if !seen["manifest.json"] || !seen["pandalibrary.db"] || !reflect.DeepEqual(actual, m.Files) {
		return fmt.Errorf("%w: missing files or checksum mismatch", ErrInvalid)
	}
	for _, root := range roots {
		info, err := os.Stat(filepath.Join(destination, root))
		if err != nil || !info.IsDir() {
			return fmt.Errorf("%w: missing %s directory", ErrInvalid, root)
		}
	}
	if err := validateDatabase(ctx, filepath.Join(destination, "pandalibrary.db"), actual); err != nil {
		return fmt.Errorf("%w: database: %v", ErrInvalid, err)
	}
	return nil
}

func validateDatabase(ctx context.Context, filename string, files map[string]record) (returnErr error) {
	uriPath := filepath.ToSlash(filename)
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	uri := (&url.URL{Scheme: "file", Path: uriPath}).String() + "?mode=ro&immutable=1"
	database, err := sql.Open("sqlite", uri)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, database.Close()) }()
	database.SetMaxOpenConns(1)
	var integrity string
	if err := database.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		return errors.Join(errors.New("integrity check failed"), err)
	}
	rows, err := database.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return err
	}
	broken := rows.Next()
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	if broken {
		return errors.New("foreign key check failed")
	}
	// Version 1 archives deliberately require the same schema as this binary.
	runner, err := migrations.NewRunner(database, filename, migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		return err
	}
	current, latest, err := runner.Status(ctx)
	if err != nil {
		return err
	}
	if current != latest {
		return fmt.Errorf("schema %d does not match binary schema %d", current, latest)
	}
	// A coherent SQLite snapshot alone is insufficient if referenced media are
	// missing. Orphan files are included, but referenced blobs must be present.
	for _, spec := range []struct {
		query string
		key   func(string, string) (string, error)
	}{
		{"SELECT sha256, format FROM book_files", blobstore.BookPath},
		{"SELECT cover_sha256, '' FROM books WHERE cover_sha256 IS NOT NULL", func(hash, _ string) (string, error) {
			return blobstore.CoverPath(hash, false)
		}},
		{"SELECT sha256, media_type FROM annotation_assets", blobstore.AssetPath},
	} {
		rows, err := database.QueryContext(ctx, spec.query)
		if err != nil {
			return err
		}
		for rows.Next() {
			var hash, format string
			if err := rows.Scan(&hash, &format); err != nil {
				return errors.Join(err, rows.Close())
			}
			name, err := spec.key(hash, format)
			if err != nil {
				return errors.Join(err, rows.Close())
			}
			if _, ok := files[filepath.ToSlash(name)]; !ok {
				return errors.Join(fmt.Errorf("referenced media is missing: %s", name), rows.Close())
			}
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return err
		}
	}
	return nil
}
