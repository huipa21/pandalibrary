package bookheap

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path"
	"strings"
	"time"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

const (
	maxScanDepth   = 8
	maxScanEntries = 100_000
	scanPageSize   = 500
)

// Scan statuses.
const (
	ScanRunning   = "running"
	ScanCompleted = "completed"
	ScanFailed    = "failed"
)

// Scan is a snapshot of the latest heap scan. Scans are kept in memory only.
// Invalid and duplicate files are also counted in added or updated.
type Scan struct {
	ID         int64      `json:"id"`
	Status     string     `json:"status"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	Added      int64      `json:"added"`
	Updated    int64      `json:"updated"`
	Removed    int64      `json:"removed"`
	Unchanged  int64      `json:"unchanged"`
	Invalid    int64      `json:"invalid"`
	Duplicates int64      `json:"duplicates"`
	Skipped    int64      `json:"skipped"`
	InProgress int64      `json:"in_progress"`
	Error      *string    `json:"error"`
}

func (scan *Scan) snapshot() Scan {
	result := *scan
	if scan.FinishedAt != nil {
		finished := *scan.FinishedAt
		result.FinishedAt = &finished
	}
	if scan.Error != nil {
		message := *scan.Error
		result.Error = &message
	}
	return result
}

// StartScan starts a background scan of the heap folder. When a scan is already
// running it returns that scan and started=false.
func (s *Service) StartScan(viewer catalog.Viewer) (scan Scan, started bool, err error) {
	if err := checkAdmin(viewer); err != nil {
		return Scan{}, false, err
	}
	s.scanMu.Lock()
	defer s.scanMu.Unlock()
	if s.stopped {
		return Scan{}, false, ErrStopped
	}
	if s.scan != nil && s.scan.Status == ScanRunning {
		return s.scan.snapshot(), false, nil
	}
	s.nextID++
	s.scan = &Scan{ID: s.nextID, Status: ScanRunning, StartedAt: s.now().UTC()}
	current := s.scan
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.runScan(current)
	}()
	return current.snapshot(), true, nil
}

// LatestScan returns the most recent scan, or nil when none ran since startup.
func (s *Service) LatestScan(viewer catalog.Viewer) (*Scan, error) {
	if err := checkAdmin(viewer); err != nil {
		return nil, err
	}
	s.scanMu.Lock()
	defer s.scanMu.Unlock()
	if s.scan == nil {
		return nil, nil
	}
	snapshot := s.scan.snapshot()
	return &snapshot, nil
}

func (s *Service) count(field func(*Scan) *int64) {
	s.scanMu.Lock()
	*field(s.scan)++
	s.scanMu.Unlock()
}

func (s *Service) runScan(scan *Scan) {
	err := s.scanHeap(s.ctx, scan)
	s.scanMu.Lock()
	defer s.scanMu.Unlock()
	finished := s.now().UTC()
	scan.FinishedAt = &finished
	if err != nil {
		scan.Status = ScanFailed
		message := s.safeError(err)
		if errors.Is(err, context.Canceled) {
			message = "the scan was cancelled"
		}
		scan.Error = &message
		s.logger.Warn("bookheap scan failed", "scan_id", scan.ID, "error", message)
		return
	}
	scan.Status = ScanCompleted
	s.logger.Info("bookheap scan completed", "scan_id", scan.ID, "added", scan.Added, "updated", scan.Updated,
		"removed", scan.Removed, "unchanged", scan.Unchanged, "skipped", scan.Skipped, "in_progress", scan.InProgress)
}

type scanWalk struct {
	service *Service
	root    *os.Root
	tree    fs.FS
	seen    map[string]bool
	entries int
}

var errTooManyEntries = fmt.Errorf("the bookheap has more than %d entries", maxScanEntries)

func (s *Service) scanHeap(ctx context.Context, scan *Scan) (returnErr error) {
	root, err := os.OpenRoot(s.dir)
	if err != nil {
		return fmt.Errorf("open bookheap: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	walk := &scanWalk{service: s, root: root, tree: root.FS(), seen: map[string]bool{}}
	if err := walk.dir(ctx, ".", 0); err != nil {
		return err
	}
	return s.removeMissing(ctx, root, walk.seen)
}

func (w *scanWalk) dir(ctx context.Context, dir string, depth int) error {
	s := w.service
	entries, err := fs.ReadDir(w.tree, dir)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if dir == "." {
			return fmt.Errorf("read bookheap: %w", err)
		}
		s.logger.Warn("bookheap scan cannot read a directory", "error", s.safeError(err))
		s.count(func(scan *Scan) *int64 { return &scan.Skipped })
		return nil
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		w.entries++
		if w.entries > maxScanEntries {
			return errTooManyEntries
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		rel := name
		if dir != "." {
			rel = path.Join(dir, name)
		}
		switch {
		case entry.Type()&fs.ModeSymlink != 0:
			s.count(func(scan *Scan) *int64 { return &scan.Skipped })
		case entry.IsDir():
			if depth+1 > maxScanDepth || !validRelPath(rel) {
				s.count(func(scan *Scan) *int64 { return &scan.Skipped })
				continue
			}
			if err := w.dir(ctx, rel, depth+1); err != nil {
				return err
			}
		case !entry.Type().IsRegular() || !supportedExtension(name) || !validRelPath(rel):
			s.count(func(scan *Scan) *int64 { return &scan.Skipped })
		default:
			w.seen[rel] = true
			if err := s.scanFile(ctx, w.root, rel); err != nil {
				return err
			}
		}
	}
	return nil
}

// scanFile indexes one regular heap file. Only cancellation and database or
// storage failures are returned; per-file problems are recorded on the row.
func (s *Service) scanFile(ctx context.Context, root *os.Root, rel string) error {
	info, err := lstatRegular(root, rel)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			s.count(func(scan *Scan) *int64 { return &scan.Skipped })
		}
		return nil
	}
	existing, err := sqlc.New(s.reader).BookheapByPath(ctx, rel)
	found := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("look up bookheap item: %w", err)
	}
	if found && existing.SizeBytes == info.Size() && existing.MtimeNs == info.ModTime().UnixNano() {
		s.count(func(scan *Scan) *int64 { return &scan.Unchanged })
		return nil
	}
	if s.now().Sub(info.ModTime()) < s.settle {
		s.count(func(scan *Scan) *int64 { return &scan.InProgress })
		return nil
	}
	if found && (existing.Status == StatusQueued || existing.Status == StatusImporting) {
		s.count(func(scan *Scan) *int64 { return &scan.Unchanged })
		return nil
	}

	result, sha, size, mtime, err := s.inspect(ctx, root, rel, info)
	if err != nil {
		return err
	}

	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	now, err := lstatRegular(root, rel)
	if err != nil || now.Size() != size || now.ModTime().UnixNano() != mtime {
		s.count(func(scan *Scan) *int64 { return &scan.InProgress })
		return nil
	}
	outcome := ""
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		status := StatusReady
		var duplicateBook, duplicateItem int64
		if result.invalid {
			status = StatusInvalid
		} else {
			beforeID := int64(math.MaxInt64)
			if found {
				beforeID = existing.ID
			}
			var duplicate *DuplicateError
			if err := duplicateOf(ctx, queries, sha, beforeID); errors.As(err, &duplicate) {
				status = StatusDuplicate
				duplicateBook, duplicateItem = duplicate.BookID, duplicate.ItemID
			} else if err != nil {
				return err
			}
		}
		stamp := s.now().UnixMilli()
		params := insertParams(result, rel, size, mtime, sha, "scan", status, stamp)
		params.DuplicateOfBookID = nullID(duplicateBook)
		params.DuplicateOfItemID = nullID(duplicateItem)
		if !found {
			if _, err := queries.BookheapInsert(ctx, params); errors.Is(err, sql.ErrNoRows) {
				outcome = "unchanged"
				return nil
			} else if err != nil {
				return fmt.Errorf("insert bookheap item: %w", err)
			}
			outcome = "added"
		} else {
			rows, err := queries.BookheapUpdateScanned(ctx, sqlc.BookheapUpdateScannedParams{
				FileName: params.FileName, SizeBytes: size, MtimeNs: mtime, Sha256: params.Sha256, Format: params.Format,
				Title: params.Title, Authors: params.Authors, Language: params.Language, Series: params.Series,
				SeriesIndex: params.SeriesIndex, CoverSha256: params.CoverSha256, Status: status, Error: params.Error,
				DuplicateOfBookID: params.DuplicateOfBookID, DuplicateOfItemID: params.DuplicateOfItemID,
				UpdatedAt: stamp, ID: existing.ID,
			})
			if err != nil {
				return fmt.Errorf("update bookheap item: %w", err)
			}
			if rows == 0 {
				outcome = "unchanged"
				return nil
			}
			outcome = "updated"
		}
		switch status {
		case StatusInvalid:
			outcome += "+invalid"
		case StatusDuplicate:
			outcome += "+duplicate"
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.scanMu.Lock()
	defer s.scanMu.Unlock()
	base, flag, _ := strings.Cut(outcome, "+")
	switch base {
	case "added":
		s.scan.Added++
	case "updated":
		s.scan.Updated++
	default:
		s.scan.Unchanged++
	}
	switch flag {
	case "invalid":
		s.scan.Invalid++
	case "duplicate":
		s.scan.Duplicates++
	}
	return nil
}

// inspect hashes and analyzes an opened heap file. Unreadable files become
// invalid with no SHA-256.
func (s *Service) inspect(ctx context.Context, root *os.Root, rel string, info fs.FileInfo) (result analysis, sha string, size, mtime int64, err error) {
	unreadable := func(problem error) (analysis, string, int64, int64, error) {
		return analysis{title: fallbackTitle(path.Base(rel)), invalid: true, problem: "the file could not be read: " + s.safeError(problem)},
			"", info.Size(), info.ModTime().UnixNano(), nil
	}
	file, opened, err := openRegular(root, rel)
	if err != nil {
		return unreadable(err)
	}
	defer file.Close()
	sha, size, err = hashFile(ctx, file)
	if ctxErr := ctx.Err(); ctxErr != nil {
		return analysis{}, "", 0, 0, ctxErr
	}
	if err != nil {
		return unreadable(err)
	}
	if size != opened.Size() {
		return unreadable(errors.New("the file changed while it was read"))
	}
	result, err = s.analyze(ctx, file, size, path.Base(rel))
	if err != nil {
		return analysis{}, "", 0, 0, err
	}
	return result, sha, size, opened.ModTime().UnixNano(), nil
}

// removeMissing deletes idle rows whose files were not seen and no longer exist.
func (s *Service) removeMissing(ctx context.Context, root *os.Root, seen map[string]bool) error {
	queries := sqlc.New(s.reader)
	var after int64
	for {
		rows, err := queries.BookheapScanEntries(ctx, sqlc.BookheapScanEntriesParams{AfterID: after, PageLimit: scanPageSize})
		if err != nil {
			return fmt.Errorf("list bookheap items: %w", err)
		}
		for _, row := range rows {
			after = row.ID
			if seen[row.RelPath] || row.Status == StatusQueued || row.Status == StatusImporting {
				continue
			}
			removed, err := s.removeIfMissing(ctx, root, row.ID, row.RelPath)
			if err != nil {
				return err
			}
			if removed {
				s.count(func(scan *Scan) *int64 { return &scan.Removed })
			}
		}
		if len(rows) < scanPageSize {
			return nil
		}
	}
}

func (s *Service) removeIfMissing(ctx context.Context, root *os.Root, itemID int64, rel string) (bool, error) {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	if !validRelPath(rel) {
		return false, nil
	}
	if _, err := root.Lstat(native(rel)); !errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	rows, err := sqlc.New(s.writer).BookheapDeleteIdle(ctx, itemID)
	if err != nil {
		return false, fmt.Errorf("remove missing bookheap item: %w", err)
	}
	return rows > 0, nil
}
