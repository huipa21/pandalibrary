package importer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/extract"
	"pandalibrary/internal/extract/cbz"
	"pandalibrary/internal/extract/epub"
	"pandalibrary/internal/extract/fb2"
	"pandalibrary/internal/extract/mobi"
	"pandalibrary/internal/extract/pdf"
)

var ErrStopped = errors.New("importer is stopping")

var errDropChanged = errors.New("drop source changed; refusing to remove it")

type Options struct {
	Writer   *sql.DB
	Reader   *sql.DB
	Blobs    *blobstore.Store
	Catalog  *catalog.Service
	DataDir  string
	DropDir  string
	MaxBytes int64
	DropPoll time.Duration
	Logger   *slog.Logger
}

type Service struct {
	options    Options
	registry   *extract.Registry
	mu         sync.Mutex
	stopped    bool
	started    bool
	cancel     context.CancelFunc
	runContext context.Context
	done       chan struct{}
	wake       chan struct{}
	rescan     chan struct{}
	workers    sync.WaitGroup
	dropMu     sync.Mutex
	dropQueued map[string]bool
	// hooksMu guards hooks separately from mu: workers look hooks up while holding a
	// writer transaction, and enqueueWith holds mu while waiting for the writer.
	hooksMu   sync.RWMutex
	hooks     map[string]Hook
	recovered []recoveredJob
}

type Job struct {
	ID                int64      `json:"id"`
	Source            string     `json:"source"`
	LibraryID         int64      `json:"library_id"`
	UserID            *int64     `json:"user_id"`
	OriginalName      string     `json:"original_name"`
	SHA256            *string    `json:"sha256"`
	Status            string     `json:"status"`
	Error             *string    `json:"error"`
	BookID            *int64     `json:"book_id"`
	DuplicateOfBookID *int64     `json:"duplicate_of_book_id"`
	CreatedAt         time.Time  `json:"created_at"`
	FinishedAt        *time.Time `json:"finished_at"`
}

type manifest struct {
	Visibility string               `json:"visibility,omitempty"`
	Staged     blobstore.StagedBook `json:"staged"`
	BookID     int64                `json:"book_id"`
	DropPath   string               `json:"drop_path,omitempty"`
	DropSize   int64                `json:"drop_size,omitempty"`
	DropMtime  int64                `json:"drop_mtime,omitempty"`
	Failure    string               `json:"failure,omitempty"`
	Hook       json.RawMessage      `json:"hook,omitempty"`
}

func New(options Options) (*Service, error) {
	if options.Writer == nil || options.Reader == nil || options.Blobs == nil || options.Catalog == nil ||
		options.DataDir == "" || options.DropDir == "" || options.Logger == nil || options.MaxBytes <= 0 || options.DropPoll < 0 {
		return nil, errors.New("importer requires databases, storage, catalog, directories, logger, and positive size limit")
	}
	var err error
	options.DataDir, err = filepath.Abs(options.DataDir)
	if err != nil {
		return nil, err
	}
	options.DropDir, err = filepath.Abs(options.DropDir)
	if err != nil {
		return nil, err
	}
	for _, dir := range []string{filepath.Join(options.DataDir, "tmp", "imports"), options.DropDir} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, err
		}
	}
	registry, err := NewRegistry()
	if err != nil {
		return nil, err
	}
	return &Service{options: options, registry: registry, done: make(chan struct{}), wake: make(chan struct{}, 1), rescan: make(chan struct{}, 1), dropQueued: make(map[string]bool)}, nil
}

// NewRegistry returns an extract registry with every supported ebook format registered.
func NewRegistry() (*extract.Registry, error) {
	registry := extract.NewRegistry(0)
	for _, register := range []func(*extract.Registry) error{epub.Register, pdf.Register, mobi.Register, fb2.Register, cbz.Register} {
		if err := register(registry); err != nil {
			return nil, err
		}
	}
	return registry, nil
}

func ValidFilename(name string) bool {
	return name != "" && len(name) <= 255 && utf8.ValidString(name) && name != "." && name != ".." &&
		strings.TrimSpace(name) == name && !strings.ContainsAny(name, "/\\:<>\"|?*") &&
		!strings.HasSuffix(name, ".") && !strings.ContainsFunc(name, unicode.IsControl)
}

func (s *Service) Stage(ctx context.Context, reader io.Reader) (blobstore.StagedBook, error) {
	s.mu.Lock()
	stopped := s.stopped || s.runContext != nil && s.runContext.Err() != nil
	s.mu.Unlock()
	if stopped {
		return blobstore.StagedBook{}, ErrStopped
	}
	staged, err := s.options.Blobs.StageBook(ctx, io.LimitReader(reader, s.options.MaxBytes+1))
	if err != nil {
		return staged, err
	}
	if staged.Size > s.options.MaxBytes {
		return blobstore.StagedBook{}, errors.Join(catalog.ErrTooLarge, s.options.Blobs.RemoveStaged(staged.Token))
	}
	return staged, nil
}

func (s *Service) Discard(staged blobstore.StagedBook) error {
	return s.options.Blobs.RemoveStaged(staged.Token)
}

func (s *Service) QueueUpload(ctx context.Context, viewer catalog.Viewer, libraryID, bookID int64, name string, staged blobstore.StagedBook, visibilityOption ...string) (Job, error) {
	visibility := "public"
	if len(visibilityOption) > 1 {
		return Job{}, catalog.ErrInvalid
	}
	if len(visibilityOption) == 1 {
		visibility = visibilityOption[0]
	}
	if visibility != "public" && visibility != "private" {
		return Job{}, catalog.ErrInvalid
	}
	if !viewer.IsAdmin || viewer.UserID < 1 {
		return Job{}, catalog.ErrForbidden
	}
	if !ValidFilename(name) || libraryID < 1 || bookID < 0 || !blobstore.ValidHash(staged.SHA256) || staged.Size <= 0 {
		return Job{}, catalog.ErrInvalid
	}
	if _, err := s.options.Catalog.GetLibrary(ctx, viewer, libraryID); err != nil {
		return Job{}, err
	}
	if bookID != 0 {
		book, err := s.options.Catalog.GetBook(ctx, viewer, bookID)
		if err != nil {
			return Job{}, err
		}
		if book.LibraryID != libraryID {
			return Job{}, catalog.ErrInvalid
		}
	}
	return s.enqueue(ctx, "upload", libraryID, viewer.UserID, name, manifest{Staged: staged, BookID: bookID, Visibility: visibility})
}

func (s *Service) enqueue(ctx context.Context, source string, libraryID, userID int64, name string, input manifest) (Job, error) {
	return s.enqueueWith(ctx, source, libraryID, userID, name, input, nil)
}

func (s *Service) History(ctx context.Context, viewer catalog.Viewer, before int64, limit int) (catalog.Page[Job], error) {
	page := catalog.Page[Job]{Items: []Job{}}
	if !viewer.IsAdmin || viewer.UserID < 1 {
		return page, catalog.ErrForbidden
	}
	if before < 0 || limit < 1 || limit > 100 {
		return page, catalog.ErrInvalid
	}
	rows, err := sqlc.New(s.options.Reader).ImportHistory(ctx, sqlc.ImportHistoryParams{BeforeID: before, PageLimit: int64(limit + 1)})
	if err != nil {
		return page, err
	}
	if len(rows) > limit {
		cursor := strconv.FormatInt(rows[limit-1].ID, 10)
		page.NextCursor = &cursor
		rows = rows[:limit]
	}
	for _, row := range rows {
		job := jobDTO(row)
		for _, id := range []**int64{&job.BookID, &job.DuplicateOfBookID} {
			if *id == nil {
				continue
			}
			if err := s.options.Catalog.CheckVisible(ctx, viewer, **id); errors.Is(err, catalog.ErrNotFound) {
				*id = nil
			} else if err != nil {
				return page, err
			}
		}
		page.Items = append(page.Items, job)
	}
	return page, nil
}

func (s *Service) Start(parent context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return ErrStopped
	}
	if s.started {
		return errors.New("importer already started")
	}
	if err := parent.Err(); err != nil {
		return err
	}
	if err := sqlc.New(s.options.Writer).ImportResume(parent); err != nil {
		return err
	}
	if err := s.recoverManifests(parent); err != nil {
		return err
	}
	s.recoverHooks(parent)
	recovered := s.recovered
	s.recovered = nil
	watcher, err := s.newWatcher()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	s.cancel = cancel
	s.runContext = ctx
	s.started = true
	if len(recovered) > 0 {
		s.workers.Add(1)
		go func() { defer s.workers.Done(); s.runRecovered(recovered) }()
	}
	s.workers.Add(1)
	go func() { defer s.workers.Done(); s.watch(ctx, watcher) }()
	for range 2 {
		s.workers.Add(1)
		go func() { defer s.workers.Done(); s.worker(ctx) }()
	}
	go func() { s.workers.Wait(); close(s.done) }()
	return nil
}

func (s *Service) Stop(ctx context.Context) error {
	s.mu.Lock()
	s.stopped = true
	started := s.started
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	if !started {
		return nil
	}
	select {
	case <-s.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Service) worker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		row, err := sqlc.New(s.options.Writer).ImportClaim(ctx)
		if err == nil {
			s.process(ctx, row)
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) && ctx.Err() == nil {
			s.options.Logger.Error("claim import job", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-ticker.C:
		}
	}
}

func manifestName(id int64) string {
	return filepath.Join("tmp", "imports", strconv.FormatInt(id, 10)+".json")
}

func (s *Service) writeManifest(id int64, input manifest) (returnErr error) {
	root, err := os.OpenRoot(s.options.DataDir)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	file, err := root.OpenFile(manifestName(id), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	encodeErr := json.NewEncoder(file).Encode(input)
	return errors.Join(encodeErr, file.Sync(), file.Close())
}

func (s *Service) readManifest(id int64) (input manifest, returnErr error) {
	file, err := os.OpenInRoot(s.options.DataDir, manifestName(id))
	if err != nil {
		return input, err
	}
	defer func() { returnErr = errors.Join(returnErr, file.Close()) }()
	err = json.NewDecoder(io.LimitReader(file, 16<<10)).Decode(&input)
	return input, err
}

func nullableID(value int64) sql.NullInt64 { return sql.NullInt64{Int64: value, Valid: value != 0} }
func text(value string) sql.NullString     { return sql.NullString{String: value, Valid: value != ""} }
func optionalText(value *string) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return text(*value)
}
func pointer[T any](value T, valid bool) *T {
	if !valid {
		return nil
	}
	return &value
}

func jobDTO(row sqlc.ImportJob) Job {
	return Job{ID: row.ID, Source: row.Source, LibraryID: row.LibraryID, UserID: pointer(row.UserID.Int64, row.UserID.Valid),
		OriginalName: row.OriginalName, SHA256: pointer(row.Sha256.String, row.Sha256.Valid), Status: row.Status,
		Error: pointer(row.Error.String, row.Error.Valid), BookID: pointer(row.BookID.Int64, row.BookID.Valid),
		DuplicateOfBookID: pointer(row.DuplicateOfBookID.Int64, row.DuplicateOfBookID.Valid), CreatedAt: time.UnixMilli(row.CreatedAt).UTC(),
		FinishedAt: pointer(time.UnixMilli(row.FinishedAt.Int64).UTC(), row.FinishedAt.Valid)}
}

func (s *Service) safeError(err error) string {
	message := strings.ReplaceAll(strings.ReplaceAll(err.Error(), s.options.DataDir, "[storage]"), s.options.DropDir, "[drop]")
	message = strings.Map(func(char rune) rune {
		if unicode.IsControl(char) {
			return ' '
		}
		return char
	}, message)
	if len(message) > 2048 {
		message = strings.ToValidUTF8(message[:2048], "")
	}
	return message
}

func (s *Service) finish(ctx context.Context, queries *sqlc.Queries, id int64, status string, bookID, duplicateID int64, failure string) error {
	if err := queries.ImportFinish(ctx, sqlc.ImportFinishParams{ID: id, Status: status, BookID: nullableID(bookID),
		DuplicateOfBookID: nullableID(duplicateID), Error: text(failure), FinishedAt: nullableID(time.Now().UnixMilli())}); err != nil {
		return fmt.Errorf("finish import job %d: %w", id, err)
	}
	return nil
}
