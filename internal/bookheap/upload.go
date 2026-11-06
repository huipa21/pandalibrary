package bookheap

import (
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
	"math"
	"os"
	"strconv"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/importer"
)

const maxNameCandidates = 1000

// Pending is an upload streamed into a dot-prefixed temp file in the heap root.
// Call Commit to store it, or Discard to remove it; Discard is always safe.
type Pending struct {
	service *Service
	temp    string
	name    string
	size    int64
	sha256  string
	userID  int64
}

// Receive validates the file name and streams reader into a temp file while
// hashing it. Content larger than the size limit returns ErrTooLarge.
func (s *Service) Receive(ctx context.Context, viewer catalog.Viewer, name string, reader io.Reader) (_ *Pending, returnErr error) {
	if err := checkAdmin(viewer); err != nil {
		return nil, err
	}
	if s.isStopped() {
		return nil, ErrStopped
	}
	if !importer.ValidFilename(name) {
		return nil, fmt.Errorf("%w: the file name is invalid", catalog.ErrInvalid)
	}
	root, err := os.OpenRoot(s.dir)
	if err != nil {
		return nil, fmt.Errorf("open bookheap: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	pending := &Pending{service: s, temp: ".upload-" + hex.EncodeToString(random[:]) + ".part", name: name, userID: viewer.UserID}
	file, err := root.OpenFile(pending.temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return nil, fmt.Errorf("create upload temp file: %w", err)
	}
	defer func() {
		if returnErr != nil {
			returnErr = errors.Join(returnErr, pending.Discard())
		}
	}()
	hash := sha256.New()
	size, copyErr := io.CopyBuffer(io.MultiWriter(file, hash), contextReader{ctx: ctx, reader: io.LimitReader(reader, s.maxBytes+1)}, make([]byte, 64<<10))
	var syncErr error
	if copyErr == nil {
		syncErr = file.Sync()
	}
	if err := errors.Join(copyErr, syncErr, file.Close()); err != nil {
		return nil, err
	}
	if size > s.maxBytes {
		return nil, ErrTooLarge
	}
	if size == 0 {
		return nil, fmt.Errorf("%w: the uploaded file is empty", catalog.ErrInvalid)
	}
	pending.size = size
	pending.sha256 = hex.EncodeToString(hash.Sum(nil))
	return pending, nil
}

// Discard removes the temp file. It is idempotent.
func (p *Pending) Discard() (returnErr error) {
	if p == nil || p.temp == "" {
		return nil
	}
	root, err := os.OpenRoot(p.service.dir)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	if err := root.Remove(p.temp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	p.temp = ""
	return nil
}

// Upload receives and commits one file.
func (s *Service) Upload(ctx context.Context, viewer catalog.Viewer, name string, reader io.Reader) (Item, error) {
	pending, err := s.Receive(ctx, viewer, name, reader)
	if err != nil {
		return Item{}, err
	}
	return s.Commit(ctx, viewer, pending)
}

// Commit rejects duplicates and unsupported content, extracts metadata and the
// cover, moves the file to a unique visible name and inserts its row. The temp
// file is always removed; on failure no heap file is left behind.
func (s *Service) Commit(ctx context.Context, viewer catalog.Viewer, pending *Pending) (_ Item, returnErr error) {
	defer func() { returnErr = errors.Join(returnErr, pending.Discard()) }()
	if err := checkAdmin(viewer); err != nil {
		return Item{}, err
	}
	if pending == nil || pending.temp == "" || pending.service != s {
		return Item{}, fmt.Errorf("%w: the upload is not pending", catalog.ErrInvalid)
	}
	if s.isStopped() {
		return Item{}, ErrStopped
	}
	if err := duplicateOf(ctx, sqlc.New(s.reader), pending.sha256, math.MaxInt64); err != nil {
		return Item{}, err
	}
	root, err := os.OpenRoot(s.dir)
	if err != nil {
		return Item{}, fmt.Errorf("open bookheap: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	file, err := root.Open(pending.temp)
	if err != nil {
		return Item{}, fmt.Errorf("open upload temp file: %w", err)
	}
	result, err := s.analyze(ctx, file, pending.size, pending.name)
	if err := errors.Join(err, file.Close()); err != nil {
		return Item{}, err
	}
	if result.invalid {
		return Item{}, fmt.Errorf("%w: %s", ErrUnsupported, result.problem)
	}

	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	var row sqlc.BookheapItem
	final := ""
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if err := duplicateOf(ctx, queries, pending.sha256, math.MaxInt64); err != nil {
			return err
		}
		var err error
		final, err = s.placeUpload(ctx, root, queries, pending.temp, "."+result.format, sanitizeStem(pending.name))
		if err != nil {
			return err
		}
		info, err := root.Lstat(final)
		if err != nil {
			return err
		}
		now := s.now().UnixMilli()
		params := insertParams(result, final, info.Size(), info.ModTime().UnixNano(), pending.sha256, "upload", StatusReady, now)
		params.AddedBy = nullID(pending.userID)
		row, err = queries.BookheapInsert(ctx, params)
		if err != nil {
			return fmt.Errorf("insert bookheap item: %w", err)
		}
		return nil
	})
	if err != nil {
		if final != "" {
			if removeErr := root.Remove(final); removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
				err = errors.Join(err, removeErr)
			}
		}
		return Item{}, err
	}
	s.logger.Info("bookheap upload stored", "item_id", row.ID, "format", result.format, "size_bytes", row.SizeBytes)
	return itemDTO(row), nil
}

// placeUpload links (or, where links are unsupported, renames) the temp file to
// the first free candidate name without ever replacing an existing file.
func (s *Service) placeUpload(ctx context.Context, root *os.Root, queries *sqlc.Queries, temp, extension, stem string) (string, error) {
	for attempt := 1; attempt <= maxNameCandidates; attempt++ {
		candidate := stem + extension
		if attempt > 1 {
			candidate = stem + " (" + strconv.Itoa(attempt) + ")" + extension
		}
		if _, err := queries.BookheapByPath(ctx, candidate); err == nil {
			continue
		} else if !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
		if _, err := root.Lstat(candidate); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		err := root.Link(temp, candidate)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			// The candidate was free a moment ago and commitMu serializes heap writers.
			if err := root.Rename(temp, candidate); err != nil {
				return "", fmt.Errorf("move upload into the bookheap: %w", err)
			}
		}
		return candidate, nil
	}
	return "", fmt.Errorf("%w: no free file name for the upload", catalog.ErrConflict)
}

// duplicateOf returns a *DuplicateError when sha matches a library file or a heap item with a smaller ID.
func duplicateOf(ctx context.Context, queries *sqlc.Queries, sha string, beforeID int64) error {
	bookID, err := queries.BookheapDuplicateBook(ctx, sha)
	if err == nil {
		return &DuplicateError{BookID: bookID}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	itemID, err := queries.BookheapDuplicateItem(ctx, sqlc.BookheapDuplicateItemParams{Sha256: text(sha), BeforeID: beforeID})
	if err == nil {
		return &DuplicateError{ItemID: itemID}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return nil
}

func insertParams(result analysis, rel string, size, mtime int64, sha, source, status string, now int64) sqlc.BookheapInsertParams {
	authors := result.authors
	if authors == nil {
		authors = []string{}
	}
	encoded, _ := json.Marshal(authors)
	params := sqlc.BookheapInsertParams{
		RelPath: rel, FileName: baseName(rel), SizeBytes: size, MtimeNs: mtime, Sha256: text(sha), Format: text(result.format),
		Title: result.title, Authors: string(encoded), Language: text(result.language), Series: text(result.series),
		CoverSha256: text(result.cover), Source: source, Status: status, Error: text(result.problem),
		CreatedAt: now, UpdatedAt: now,
	}
	if result.seriesIndex != nil {
		params.SeriesIndex = sql.NullFloat64{Float64: *result.seriesIndex, Valid: true}
	}
	return params
}

func baseName(rel string) string {
	for index := len(rel) - 1; index >= 0; index-- {
		if rel[index] == '/' {
			return rel[index+1:]
		}
	}
	return rel
}
