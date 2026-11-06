package bookheap

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/importer"
)

const lostJobMessage = "The import job was lost; assign the item again."

// assignHook connects bookheap import jobs to their heap items.
type assignHook struct{ service *Service }

var _ importer.Hook = assignHook{}

func jobID(job importer.Job) sql.NullInt64 { return nullID(job.ID) }

// Started marks the item as importing.
func (h assignHook) Started(ctx context.Context, job importer.Job, _ json.RawMessage) error {
	s := h.service
	_, err := sqlc.New(s.writer).BookheapAssignStarted(ctx, sqlc.BookheapAssignStartedParams{UpdatedAt: s.now().UnixMilli(), ImportJobID: jobID(job)})
	return err
}

// Imported runs inside the importer's book transaction: it adds the book to every target
// shelf the assigning user can still write, skipping the rest, then deletes the heap row.
func (h assignHook) Imported(ctx context.Context, tx *sql.Tx, job importer.Job, bookID int64, payload json.RawMessage) error {
	s := h.service
	queries := sqlc.New(tx)
	row, err := queries.BookheapAssignByJob(ctx, jobID(job))
	if errors.Is(err, sql.ErrNoRows) {
		s.logger.Warn("bookheap import has no queued item", "job_id", job.ID)
		return nil
	}
	if err != nil {
		return fmt.Errorf("find assigned bookheap item: %w", err)
	}
	var shelfIDs []int64
	if err := json.Unmarshal([]byte(row.TargetShelfIds), &shelfIDs); err != nil {
		var input assignPayload
		if json.Unmarshal(payload, &input) == nil {
			shelfIDs = input.ShelfIDs
		}
	}
	skipped := 0
	if len(shelfIDs) > 0 {
		viewer, ok, err := assigningViewer(ctx, queries, job)
		if err != nil {
			return err
		}
		now := s.now().UnixMilli()
		for _, shelfID := range shelfIDs {
			if !ok {
				skipped++
				continue
			}
			err := catalog.AddAssignedBookTx(ctx, tx, viewer, shelfID, bookID, now)
			switch {
			case err == nil:
			case errors.Is(err, catalog.ErrNotFound), errors.Is(err, catalog.ErrForbidden),
				errors.Is(err, catalog.ErrConflict), errors.Is(err, catalog.ErrInvalid):
				skipped++
			default:
				return err
			}
		}
	}
	if skipped > 0 {
		s.logger.Warn("skipped bookheap target shelves that are no longer writable", "job_id", job.ID, "book_id", bookID, "skipped", skipped)
	}
	if _, err := queries.BookheapAssignDeleteImported(ctx, jobID(job)); err != nil {
		return fmt.Errorf("delete imported bookheap item: %w", err)
	}
	return nil
}

func assigningViewer(ctx context.Context, queries *sqlc.Queries, job importer.Job) (catalog.Viewer, bool, error) {
	if job.UserID == nil {
		return catalog.Viewer{}, false, nil
	}
	user, err := queries.BookheapAssignUser(ctx, *job.UserID)
	if errors.Is(err, sql.ErrNoRows) {
		return catalog.Viewer{}, false, nil
	}
	if err != nil {
		return catalog.Viewer{}, false, fmt.Errorf("load assigning user: %w", err)
	}
	if user.Disabled != 0 {
		return catalog.Viewer{}, false, nil
	}
	return catalog.Viewer{UserID: *job.UserID, IsAdmin: user.Role == "admin"}, true, nil
}

// Finished removes the heap file after a committed import, or records a duplicate or
// failure on the heap item. It is safe to run more than once for the same job.
func (h assignHook) Finished(ctx context.Context, job importer.Job, payload json.RawMessage) error {
	s := h.service
	known := s.forgetFile(job.ID)
	switch job.Status {
	case "imported":
		var input assignPayload
		if err := json.Unmarshal(payload, &input); err != nil || input.RelPath == "" {
			return fmt.Errorf("bookheap import %d has no usable manifest payload", job.ID)
		}
		return s.removeImported(ctx, job.ID, input, known)
	case "duplicate":
		var duplicate int64
		if job.DuplicateOfBookID != nil {
			duplicate = *job.DuplicateOfBookID
		}
		return s.finishItem(ctx, job.ID, StatusDuplicate, "", duplicate)
	case "failed":
		message := "import failed"
		if job.Error != nil && *job.Error != "" {
			message = s.safeError(errors.New(*job.Error))
		}
		return s.finishItem(ctx, job.ID, StatusFailed, message, 0)
	}
	return nil
}

func (s *Service) finishItem(ctx context.Context, importJobID int64, status, message string, duplicate int64) error {
	_, err := sqlc.New(s.writer).BookheapAssignFinish(ctx, sqlc.BookheapAssignFinishParams{
		Status: status, Error: text(message), DuplicateOfBookID: nullID(duplicate), UpdatedAt: s.now().UnixMilli(), ImportJobID: nullID(importJobID),
	})
	if err != nil {
		return fmt.Errorf("finish bookheap item: %w", err)
	}
	return nil
}

// removeImported deletes the heap file only if it is still the file that was staged.
func (s *Service) removeImported(ctx context.Context, importJobID int64, input assignPayload, known fs.FileInfo) (returnErr error) {
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	root, err := os.OpenRoot(s.dir)
	if err != nil {
		return fmt.Errorf("open bookheap: %w", err)
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	info, err := lstatRegular(root, input.RelPath)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil || info.Size() != input.Size || info.ModTime().UnixNano() != input.MtimeNs || known != nil && !os.SameFile(known, info) {
		s.logger.Warn("keeping changed bookheap file after import", "job_id", importJobID)
		return nil
	}
	if err := root.Remove(native(input.RelPath)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove imported bookheap file: %w", err)
	}
	// A scan between the book commit and the removal may have re-indexed the file.
	if _, err := sqlc.New(s.writer).BookheapAssignDeleteIdlePath(ctx, input.RelPath); err != nil {
		return fmt.Errorf("delete re-indexed bookheap row: %w", err)
	}
	return nil
}

// Recover reconciles queued/importing items whose job is gone or already finished.
// Items whose job is still pending or processing are left for the importer.
func (h assignHook) Recover(ctx context.Context) error {
	s := h.service
	rows, err := sqlc.New(s.writer).BookheapAssignBusy(ctx)
	if err != nil {
		return fmt.Errorf("list busy bookheap items: %w", err)
	}
	for _, row := range rows {
		params := sqlc.BookheapAssignResolveParams{ID: row.ID, UpdatedAt: s.now().UnixMilli()}
		switch {
		case !row.JobStatus.Valid:
			params.Status, params.Error = StatusFailed, text(lostJobMessage)
		case row.JobStatus.String == "pending" || row.JobStatus.String == "processing":
			continue
		case row.JobStatus.String == "failed":
			message := "import failed"
			if row.JobError.Valid && row.JobError.String != "" {
				message = s.safeError(errors.New(row.JobError.String))
			}
			params.Status, params.Error = StatusFailed, text(message)
		case row.JobStatus.String == "duplicate":
			params.Status, params.DuplicateOfBookID = StatusDuplicate, row.JobDuplicateOfBookID
		default:
			// The job imported the file but this row survived; the book now holds the content.
			params.Status, params.DuplicateOfBookID = StatusDuplicate, row.JobBookID
		}
		if _, err := sqlc.New(s.writer).BookheapAssignResolve(ctx, params); err != nil {
			return fmt.Errorf("reconcile bookheap item %d: %w", row.ID, err)
		}
	}
	return nil
}
