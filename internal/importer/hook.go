package importer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"time"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

// Hook lets one import source react to the lifecycle of its jobs. Payload is the opaque
// JSON stored in the job manifest by QueueHooked. Upload and drop-folder jobs never call
// hooks.
type Hook interface {
	// Started runs when a worker claims the job, before any import work.
	Started(ctx context.Context, job Job, payload json.RawMessage) error
	// Imported runs inside the transaction that creates the book, after the file row
	// and search index are written. An error rolls the import back and fails the job.
	// It must use only tx for database work.
	Imported(ctx context.Context, tx *sql.Tx, job Job, bookID int64, payload json.RawMessage) error
	// Finished runs after the job reaches imported, duplicate or failed, before staged
	// file and manifest cleanup, including for jobs finished before a restart.
	Finished(ctx context.Context, job Job, payload json.RawMessage) error
	// Recover runs once at Start, after manifest recovery, before workers start.
	Recover(ctx context.Context) error
}

const hookTimeout = 30 * time.Second

var hookSources = map[string]bool{"bookheap": true}

// SetHook registers the lifecycle hook for source. It must be called before Start.
func (s *Service) SetHook(source string, hook Hook) error {
	if !hookSources[source] || hook == nil {
		return errors.New("importer hooks are only supported for the bookheap source")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started || s.stopped {
		return errors.New("importer hooks must be registered before start")
	}
	s.hooksMu.Lock()
	defer s.hooksMu.Unlock()
	if s.hooks == nil {
		s.hooks = make(map[string]Hook)
	}
	if _, exists := s.hooks[source]; exists {
		return errors.New("importer hook already registered")
	}
	s.hooks[source] = hook
	return nil
}

func (s *Service) hook(source string) Hook {
	s.hooksMu.RLock()
	defer s.hooksMu.RUnlock()
	return s.hooks[source]
}

// QueueHooked queues a staged file for a hooked source. inTx runs in the transaction that
// creates the job; if it fails, nothing is queued and the caller still owns staged.
func (s *Service) QueueHooked(ctx context.Context, viewer catalog.Viewer, source string, libraryID int64, name string,
	staged blobstore.StagedBook, payload json.RawMessage, inTx func(*sql.Tx, Job) error) (Job, error) {
	if !viewer.IsAdmin || viewer.UserID < 1 {
		return Job{}, catalog.ErrForbidden
	}
	if !ValidFilename(name) || libraryID < 1 || !blobstore.ValidHash(staged.SHA256) || staged.Size <= 0 || !json.Valid(payload) {
		return Job{}, catalog.ErrInvalid
	}
	if s.hook(source) == nil {
		return Job{}, errors.New("import source has no registered hook")
	}
	if _, err := s.options.Catalog.GetLibrary(ctx, viewer, libraryID); err != nil {
		return Job{}, err
	}
	return s.enqueueWith(ctx, source, libraryID, viewer.UserID, name, manifest{Staged: staged, Hook: payload}, inTx)
}

func (s *Service) hookStarted(ctx context.Context, row sqlc.ImportJob, input manifest) {
	hook := s.hook(row.Source)
	if hook == nil {
		return
	}
	if err := hook.Started(ctx, jobDTO(row), input.Hook); err != nil && ctx.Err() == nil {
		s.options.Logger.Error("import hook start", "job_id", row.ID, "source", row.Source, "error", err)
	}
}

func (s *Service) hookFinished(row sqlc.ImportJob, input manifest) {
	hook := s.hook(row.Source)
	if hook == nil || row.Status == "pending" || row.Status == "processing" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), hookTimeout)
	defer cancel()
	if err := hook.Finished(ctx, jobDTO(row), input.Hook); err != nil {
		s.options.Logger.Error("import hook finish", "job_id", row.ID, "source", row.Source, "error", err)
	}
}

type recoveredJob struct {
	row   sqlc.ImportJob
	input manifest
}

// recoverHooks runs each hook's Recover; Finished for jobs completed before a restart runs
// later from runRecovered so it does not hold the importer lock.
func (s *Service) recoverHooks(ctx context.Context) {
	for source, hook := range s.hooks {
		if err := hook.Recover(ctx); err != nil {
			s.options.Logger.Error("recover import hook", "source", source, "error", err)
		}
	}
}

func (s *Service) runRecovered(recovered []recoveredJob) {
	for _, job := range recovered {
		s.hookFinished(job.row, job.input)
		if err := s.cleanup(job.row, job.input); err != nil {
			s.options.Logger.Error("recover import cleanup", "job_id", job.row.ID, "error", err)
		}
	}
}

func (s *Service) enqueueWith(ctx context.Context, source string, libraryID, userID int64, name string, input manifest,
	inTx func(*sql.Tx, Job) error) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped || s.runContext != nil && s.runContext.Err() != nil {
		return Job{}, ErrStopped
	}
	var row sqlc.ImportJob
	err := db.WithTx(ctx, s.options.Writer, func(tx *sql.Tx) error {
		var err error
		row, err = sqlc.New(tx).ImportCreateJob(ctx, sqlc.ImportCreateJobParams{
			Source: source, LibraryID: libraryID, UserID: nullableID(userID), OriginalName: name,
			Sha256: text(input.Staged.SHA256), CreatedAt: time.Now().UnixMilli(),
		})
		if err != nil {
			return err
		}
		if inTx != nil {
			if err := inTx(tx, jobDTO(row)); err != nil {
				return err
			}
		}
		return s.writeManifest(row.ID, input)
	})
	if err != nil {
		if row.ID != 0 && inTx != nil {
			s.removeManifest(row.ID)
		}
		return Job{}, err
	}
	if input.DropPath != "" {
		s.dropMu.Lock()
		s.dropQueued[input.DropPath] = true
		s.dropMu.Unlock()
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
	return jobDTO(row), nil
}

func (s *Service) removeManifest(id int64) {
	root, err := os.OpenRoot(s.options.DataDir)
	if err == nil {
		err = root.Remove(manifestName(id))
		if errors.Is(err, os.ErrNotExist) {
			err = nil
		}
		err = errors.Join(err, root.Close())
	}
	if err != nil {
		s.options.Logger.Warn("remove orphan import manifest", "job_id", id, "error", err)
	}
}
