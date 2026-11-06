package bookheap

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/extract"
	"pandalibrary/internal/importer"
)

var (
	// ErrStopped reports that the service is shutting down.
	ErrStopped = errors.New("bookheap is stopping")
	// ErrUnsupported reports an upload whose content is not a supported, readable ebook.
	ErrUnsupported = errors.New("unsupported or corrupt ebook format")
	// ErrTooLarge reports an upload that exceeds the configured size limit.
	ErrTooLarge = errors.New("upload exceeds the size limit")
)

// DuplicateError reports an upload whose SHA-256 matches a library file or a heap item.
// Exactly one of BookID and ItemID is non-zero.
type DuplicateError struct {
	BookID int64
	ItemID int64
}

func (e *DuplicateError) Error() string {
	if e.BookID != 0 {
		return fmt.Sprintf("duplicate of library book %d", e.BookID)
	}
	return fmt.Sprintf("duplicate of bookheap item %d", e.ItemID)
}

// Item statuses.
const (
	StatusReady     = "ready"
	StatusDuplicate = "duplicate"
	StatusInvalid   = "invalid"
	StatusQueued    = "queued"
	StatusImporting = "importing"
	StatusFailed    = "failed"
)

// Options configures a Service.
type Options struct {
	Writer   *sql.DB
	Reader   *sql.DB
	Blobs    *blobstore.Store
	Dir      string
	MaxBytes int64
	Logger   *slog.Logger
}

// Service owns the heap folder, its index rows and the background scan.
type Service struct {
	writer   *sql.DB
	reader   *sql.DB
	blobs    *blobstore.Store
	dir      string
	maxBytes int64
	logger   *slog.Logger
	registry *extract.Registry

	// commitMu serializes duplicate checks, file naming, renames, row writes and
	// deletions so concurrent uploads, scans and deletes see a consistent heap.
	// Acquire it before any writer transaction, never while holding one.
	commitMu sync.Mutex

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	scanMu  sync.Mutex
	scan    *Scan
	nextID  int64
	stopped bool

	// now and settle are replaceable in tests.
	now    func() time.Time
	settle time.Duration
}

// New validates options, creates the heap directory and returns a Service.
func New(options Options) (*Service, error) {
	if options.Writer == nil || options.Reader == nil || options.Blobs == nil || options.Dir == "" ||
		options.MaxBytes <= 0 || options.Logger == nil {
		return nil, errors.New("bookheap requires databases, blob storage, a directory, a positive size limit and a logger")
	}
	dir, err := filepath.Abs(options.Dir)
	if err != nil {
		return nil, fmt.Errorf("resolve bookheap directory: %w", err)
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create bookheap directory: %w", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("inspect bookheap directory: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("bookheap path is not a directory")
	}
	registry, err := importer.NewRegistry()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{
		writer: options.Writer, reader: options.Reader, blobs: options.Blobs, dir: dir,
		maxBytes: options.MaxBytes, logger: options.Logger, registry: registry,
		ctx: ctx, cancel: cancel, now: time.Now, settle: 10 * time.Second,
	}, nil
}

// Dir returns the absolute heap directory.
func (s *Service) Dir() string { return s.dir }

// Close cancels a running scan and waits for background work to finish.
// It is safe to call more than once.
func (s *Service) Close(ctx context.Context) error {
	s.scanMu.Lock()
	s.stopped = true
	s.scanMu.Unlock()
	s.cancel()
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("stop bookheap: %w", ctx.Err())
	}
}

func (s *Service) isStopped() bool {
	s.scanMu.Lock()
	defer s.scanMu.Unlock()
	return s.stopped
}

func checkAdmin(viewer catalog.Viewer) error {
	if !viewer.IsAdmin || viewer.UserID < 1 {
		return catalog.ErrForbidden
	}
	return nil
}

// Item is the public HeapItem DTO. Arrays are never null.
type Item struct {
	ID                int64     `json:"id"`
	FileName          string    `json:"file_name"`
	RelPath           string    `json:"rel_path"`
	Format            *string   `json:"format"`
	SizeBytes         int64     `json:"size_bytes"`
	SHA256            *string   `json:"sha256"`
	Title             string    `json:"title"`
	Authors           []string  `json:"authors"`
	Language          *string   `json:"language"`
	Series            *string   `json:"series"`
	SeriesIndex       *float64  `json:"series_index"`
	HasCover          bool      `json:"has_cover"`
	CoverURL          *string   `json:"cover_url"`
	Source            string    `json:"source"`
	Status            string    `json:"status"`
	Error             *string   `json:"error"`
	DuplicateOfBookID *int64    `json:"duplicate_of_book_id"`
	DuplicateOfItemID *int64    `json:"duplicate_of_item_id"`
	TargetLibraryID   *int64    `json:"target_library_id"`
	TargetShelfIDs    []int64   `json:"target_shelf_ids"`
	ImportJobID       *int64    `json:"import_job_id"`
	AddedBy           *int64    `json:"added_by"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

func itemDTO(row sqlc.BookheapItem) Item {
	item := Item{
		ID: row.ID, FileName: row.FileName, RelPath: row.RelPath, Format: nullString(row.Format),
		SizeBytes: row.SizeBytes, SHA256: nullString(row.Sha256), Title: row.Title, Authors: []string{},
		Language: nullString(row.Language), Series: nullString(row.Series), HasCover: row.CoverSha256.Valid,
		Source: row.Source, Status: row.Status, Error: nullString(row.Error),
		DuplicateOfBookID: nullInt(row.DuplicateOfBookID), DuplicateOfItemID: nullInt(row.DuplicateOfItemID),
		TargetLibraryID: nullInt(row.TargetLibraryID), TargetShelfIDs: []int64{}, ImportJobID: nullInt(row.ImportJobID),
		AddedBy: nullInt(row.AddedBy), CreatedAt: time.UnixMilli(row.CreatedAt).UTC(), UpdatedAt: time.UnixMilli(row.UpdatedAt).UTC(),
	}
	if row.SeriesIndex.Valid {
		value := row.SeriesIndex.Float64
		item.SeriesIndex = &value
	}
	if item.HasCover {
		url := "/api/v1/admin/bookheap/items/" + strconv.FormatInt(row.ID, 10) + "/cover"
		item.CoverURL = &url
	}
	var authors []string
	if json.Unmarshal([]byte(row.Authors), &authors) == nil && authors != nil {
		item.Authors = authors
	}
	var shelves []int64
	if json.Unmarshal([]byte(row.TargetShelfIds), &shelves) == nil && shelves != nil {
		item.TargetShelfIDs = shelves
	}
	return item
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullInt(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func text(value string) sql.NullString { return sql.NullString{String: value, Valid: value != ""} }
func nullID(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: value != 0} }

// safeError returns a bounded, single-line message without server paths.
func (s *Service) safeError(err error) string {
	message := strings.ReplaceAll(err.Error(), s.dir, "[bookheap]")
	message = strings.ReplaceAll(message, filepath.ToSlash(s.dir), "[bookheap]")
	message = strings.Map(func(char rune) rune {
		if unicode.IsControl(char) {
			return ' '
		}
		return char
	}, message)
	if len(message) > 512 {
		message = strings.ToValidUTF8(message[:512], "")
	}
	return message
}
