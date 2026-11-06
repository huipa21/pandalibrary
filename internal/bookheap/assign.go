package bookheap

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"strings"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/importer"
)

const (
	// MaxAssignIDs is the largest bulk assignment request.
	MaxAssignIDs = 500
	// MaxAssignShelves is the largest number of target shelves per assignment.
	MaxAssignShelves = 20
	// ImportSource is the import job source used for heap assignments.
	ImportSource = "bookheap"
)

// Per-item assignment errors.
const (
	AssignNotFound      = "not_found"
	AssignNotAssignable = "not_assignable"
	AssignChanged       = "changed"
	AssignFailed        = "failed"
)

const changedMessage = "The file changed on disk; run a scan to refresh it."

// AssignResult is the per-item outcome of a bulk assignment. Error is null on success.
type AssignResult struct {
	ID          int64   `json:"id"`
	OK          bool    `json:"ok"`
	Error       *string `json:"error"`
	ImportJobID *int64  `json:"import_job_id"`
}

// ShelfError rejects a whole assignment because one target shelf is not a valid target.
// Err wraps catalog.ErrNotFound, ErrForbidden, ErrConflict or ErrInvalid.
type ShelfError struct {
	ShelfID int64
	Err     error
}

func (e *ShelfError) Error() string {
	return fmt.Sprintf("shelf %d cannot receive assigned books: %v", e.ShelfID, e.Err)
}

func (e *ShelfError) Unwrap() error { return e.Err }

// assignPayload is stored in the import manifest so completion and recovery work after a restart.
type assignPayload struct {
	ItemID   int64   `json:"item_id"`
	RelPath  string  `json:"rel_path"`
	Size     int64   `json:"size"`
	MtimeNs  int64   `json:"mtime_ns"`
	ShelfIDs []int64 `json:"shelf_ids"`
}

// errAssignSkipped carries a per-item code out of the queueing transaction.
type errAssignSkipped struct{ code string }

func (e errAssignSkipped) Error() string { return e.code }

// Assign queues 1..500 unique ready or failed items as bookheap import jobs into
// libraryID, optionally adding each imported book to the given manual shelves. Library
// and shelves are validated for the whole request before anything is queued.
func (s *Service) Assign(ctx context.Context, viewer catalog.Viewer, ids []int64, libraryID int64, shelfIDs []int64) ([]AssignResult, error) {
	if err := checkAdmin(viewer); err != nil {
		return nil, err
	}
	if s.importer == nil || s.catalog == nil {
		return nil, errors.New("bookheap assignment is not configured")
	}
	if len(ids) < 1 || len(ids) > MaxAssignIDs {
		return nil, fmt.Errorf("%w: ids must contain 1 to %d items", catalog.ErrInvalid, MaxAssignIDs)
	}
	if !uniquePositive(ids) {
		return nil, fmt.Errorf("%w: ids must be unique positive integers", catalog.ErrInvalid)
	}
	if shelfIDs == nil {
		shelfIDs = []int64{}
	}
	if len(shelfIDs) > MaxAssignShelves || !uniquePositive(shelfIDs) {
		return nil, fmt.Errorf("%w: shelf_ids must contain at most %d unique positive integers", catalog.ErrInvalid, MaxAssignShelves)
	}
	if libraryID < 1 {
		return nil, fmt.Errorf("%w: library_id must be a positive integer", catalog.ErrInvalid)
	}
	if s.isStopped() {
		return nil, ErrStopped
	}
	if _, err := s.catalog.GetLibrary(ctx, viewer, libraryID); err != nil {
		return nil, err
	}
	for _, shelfID := range shelfIDs {
		if err := s.catalog.CheckAssignableShelf(ctx, viewer, shelfID); err != nil {
			if errors.Is(err, catalog.ErrNotFound) || errors.Is(err, catalog.ErrForbidden) ||
				errors.Is(err, catalog.ErrConflict) || errors.Is(err, catalog.ErrInvalid) {
				return nil, &ShelfError{ShelfID: shelfID, Err: err}
			}
			return nil, err
		}
	}
	shelvesJSON, err := json.Marshal(shelfIDs)
	if err != nil {
		return nil, err
	}
	results := make([]AssignResult, 0, len(ids))
	for _, itemID := range ids {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		jobID, code, err := s.assignItem(ctx, viewer, itemID, libraryID, shelfIDs, string(shelvesJSON))
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			s.logger.Error("assign bookheap item", "item_id", itemID, "error", s.safeError(err))
			code = AssignFailed
		}
		result := AssignResult{ID: itemID, OK: code == ""}
		if code != "" {
			result.Error = &code
		} else {
			result.ImportJobID = &jobID
		}
		results = append(results, result)
	}
	return results, nil
}

func uniquePositive(values []int64) bool {
	seen := make(map[int64]bool, len(values))
	for _, value := range values {
		if value < 1 || seen[value] {
			return false
		}
		seen[value] = true
	}
	return true
}

// assignItem verifies, stages and queues one item. It returns a job ID or a per-item code.
func (s *Service) assignItem(ctx context.Context, viewer catalog.Viewer, itemID, libraryID int64, shelfIDs []int64, shelvesJSON string) (int64, string, error) {
	row, err := sqlc.New(s.reader).BookheapGet(ctx, itemID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, AssignNotFound, nil
	}
	if err != nil {
		return 0, "", fmt.Errorf("get bookheap item: %w", err)
	}
	if (row.Status != StatusReady && row.Status != StatusFailed) || !row.Sha256.Valid {
		return 0, AssignNotAssignable, nil
	}
	staged, info, code, err := s.stageItem(ctx, row)
	if err != nil || code != "" {
		if code == AssignChanged {
			s.markChanged(ctx, itemID)
		}
		return 0, code, err
	}
	payload, err := json.Marshal(assignPayload{ItemID: row.ID, RelPath: row.RelPath, Size: row.SizeBytes, MtimeNs: row.MtimeNs, ShelfIDs: shelfIDs})
	if err != nil {
		return 0, "", errors.Join(err, s.importer.Discard(staged))
	}
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	job, err := s.importer.QueueHooked(ctx, viewer, ImportSource, libraryID, jobName(row.FileName), staged, payload,
		func(tx *sql.Tx, job importer.Job) error {
			updated, err := sqlc.New(tx).BookheapAssignQueue(ctx, sqlc.BookheapAssignQueueParams{
				TargetLibraryID: nullID(libraryID), TargetShelfIds: shelvesJSON, ImportJobID: nullID(job.ID),
				UpdatedAt: s.now().UnixMilli(), ID: row.ID, SizeBytes: row.SizeBytes, MtimeNs: row.MtimeNs,
			})
			if err != nil {
				return fmt.Errorf("queue bookheap item: %w", err)
			}
			if updated == 0 {
				return s.queueSkipped(ctx, tx, row.ID)
			}
			return nil
		})
	if err != nil {
		discardErr := s.importer.Discard(staged)
		var skipped errAssignSkipped
		if errors.As(err, &skipped) {
			return 0, skipped.code, discardErr
		}
		return 0, "", errors.Join(err, discardErr)
	}
	s.rememberFile(job.ID, info)
	return job.ID, "", nil
}

// queueSkipped explains why the conditional queue update matched no row.
func (s *Service) queueSkipped(ctx context.Context, tx *sql.Tx, itemID int64) error {
	current, err := sqlc.New(tx).BookheapGet(ctx, itemID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return errAssignSkipped{AssignNotFound}
	case err != nil:
		return err
	case current.Status != StatusReady && current.Status != StatusFailed:
		return errAssignSkipped{AssignNotAssignable}
	default:
		return errAssignSkipped{AssignChanged}
	}
}

// stageItem copies the heap file into import staging after checking it is still the
// indexed file, and checks again afterwards. The heap file is never modified.
func (s *Service) stageItem(ctx context.Context, row sqlc.BookheapItem) (_ blobstore.StagedBook, _ fs.FileInfo, code string, returnErr error) {
	root, err := os.OpenRoot(s.dir)
	if err != nil {
		return blobstore.StagedBook{}, nil, "", fmt.Errorf("open bookheap: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	file, info, err := openRegular(root, row.RelPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, errNotRegular) {
			return blobstore.StagedBook{}, nil, AssignChanged, nil
		}
		return blobstore.StagedBook{}, nil, "", fmt.Errorf("open bookheap file: %w", err)
	}
	if info.Size() != row.SizeBytes || info.ModTime().UnixNano() != row.MtimeNs {
		return blobstore.StagedBook{}, nil, AssignChanged, file.Close()
	}
	staged, err := s.importer.Stage(ctx, contextReader{ctx: ctx, reader: file})
	if err := errors.Join(err, file.Close()); err != nil {
		if staged.Token != "" {
			err = errors.Join(err, s.importer.Discard(staged))
		}
		return blobstore.StagedBook{}, nil, "", fmt.Errorf("stage bookheap file: %w", err)
	}
	after, err := lstatRegular(root, row.RelPath)
	if err != nil || !os.SameFile(info, after) || after.Size() != row.SizeBytes || after.ModTime().UnixNano() != row.MtimeNs ||
		staged.Size != row.SizeBytes || staged.SHA256 != row.Sha256.String {
		return blobstore.StagedBook{}, nil, AssignChanged, s.importer.Discard(staged)
	}
	return staged, info, "", nil
}

func (s *Service) markChanged(ctx context.Context, itemID int64) {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	err := sqlc.New(s.writer).BookheapAssignMarkChanged(ctx, sqlc.BookheapAssignMarkChangedParams{
		Error: text(changedMessage), UpdatedAt: s.now().UnixMilli(), ID: itemID,
	})
	if err != nil && ctx.Err() == nil {
		s.logger.Error("mark bookheap item changed", "item_id", itemID, "error", s.safeError(err))
	}
}

// jobName is the import's original file name: the heap name, or a sanitized one.
func jobName(name string) string {
	if importer.ValidFilename(name) {
		return name
	}
	extension := strings.ToLower(path.Ext(name))
	if !importer.ValidFilename("book"+extension) {
		extension = ""
	}
	return sanitizeStem(name) + extension
}

func (s *Service) rememberFile(jobID int64, info fs.FileInfo) {
	s.assignMu.Lock()
	defer s.assignMu.Unlock()
	if s.assigned == nil {
		s.assigned = make(map[int64]fs.FileInfo)
	}
	s.assigned[jobID] = info
}

func (s *Service) forgetFile(jobID int64) fs.FileInfo {
	s.assignMu.Lock()
	defer s.assignMu.Unlock()
	info := s.assigned[jobID]
	delete(s.assigned, jobID)
	return info
}
