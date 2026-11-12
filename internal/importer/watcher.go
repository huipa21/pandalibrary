package importer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"

	"pandalibrary/internal/db/sqlc"
)

const stabilityWindow = 3 * time.Second

type candidate struct {
	size        int64
	mtime       int64
	stableSince time.Time
	libraryID   int64
}

func ignored(name string) bool {
	if strings.HasPrefix(name, ".") || !ValidFilename(name) {
		return true
	}
	switch strings.ToLower(filepath.Ext(name)) {
	case ".part", ".crdownload", ".tmp":
		return true
	}
	return false
}

func (s *Service) newWatcher() (*fsnotify.Watcher, error) {
	watcher, err := fsnotify.NewWatcher()
	if err == nil {
		err = watcher.Add(s.options.DropDir)
	}
	if err != nil {
		if watcher != nil {
			err = errors.Join(err, watcher.Close())
		}
		if s.options.DropPoll == 0 {
			return nil, fmt.Errorf("watch drop directory (configure PANDA_DROP_POLL for polling fallback): %w", err)
		}
		s.options.Logger.Warn("drop watcher unavailable; using polling", "error", err)
		return nil, nil
	}
	return watcher, nil
}

func (s *Service) watch(ctx context.Context, watcher *fsnotify.Watcher) {
	var events <-chan fsnotify.Event
	var failures <-chan error
	if watcher != nil {
		events = watcher.Events
		failures = watcher.Errors
		defer func() {
			if err := watcher.Close(); err != nil {
				s.options.Logger.Error("close drop watcher", "error", err)
			}
		}()
	}
	candidates := make(map[string]candidate)
	watched := map[string]bool{s.options.DropDir: true}
	scan := func() {
		if err := s.scanDrop(ctx, watcher, watched, candidates, time.Now()); err != nil && ctx.Err() == nil {
			s.options.Logger.Error("scan drop directory", "error", err)
		}
	}
	scan()
	settle := time.NewTicker(250 * time.Millisecond)
	defer settle.Stop()
	var polling <-chan time.Time
	if s.options.DropPoll > 0 {
		ticker := time.NewTicker(s.options.DropPoll)
		defer ticker.Stop()
		polling = ticker.C
	}
	for {
		select {
		case <-ctx.Done():
			return
		case _, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			scan()
		case err, ok := <-failures:
			if !ok {
				failures = nil
				continue
			}
			s.options.Logger.Error("drop watcher event", "error", err)
			scan()
		case <-polling:
			scan()
		case <-s.rescan:
			scan()
		case now := <-settle.C:
			for name, entry := range candidates {
				if ctx.Err() != nil {
					return
				}
				info, err := s.dropInfo(name)
				if err != nil {
					delete(candidates, name)
					continue
				}
				if info.Size() != entry.size || info.ModTime().UnixNano() != entry.mtime {
					entry.size = info.Size()
					entry.mtime = info.ModTime().UnixNano()
					entry.stableSince = now
					candidates[name] = entry
					continue
				}
				if now.Sub(entry.stableSince) < stabilityWindow {
					continue
				}
				if err := s.queueDrop(ctx, name, entry); err != nil {
					if ctx.Err() == nil {
						s.options.Logger.Error("queue drop file", "name", filepath.Base(name), "error", err)
					}
					continue
				}
				delete(candidates, name)
			}
		}
	}
}

func (s *Service) scanDrop(ctx context.Context, watcher *fsnotify.Watcher, watched map[string]bool, candidates map[string]candidate, now time.Time) (returnErr error) {
	root, err := os.OpenRoot(s.options.DropDir)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	libraries, err := sqlc.New(s.options.Reader).ImportLibraries(ctx)
	if err != nil {
		return err
	}
	if watcher != nil {
		for path := range watched {
			delete(watched, path)
		}
		for _, path := range watcher.WatchList() {
			watched[path] = true
		}
	}
	defaultID, err := sqlc.New(s.options.Reader).ImportDefaultLibrary(ctx)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	folders := map[string]int64{".": defaultID}
	for _, library := range libraries {
		if info, err := root.Lstat(library.Slug); err == nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
			folders[library.Slug] = library.ID
		}
	}
	for folder, libraryID := range folders {
		absolute := filepath.Join(s.options.DropDir, folder)
		if watcher != nil && !watched[absolute] {
			if err := watcher.Add(absolute); err != nil {
				returnErr = errors.Join(returnErr, err)
			} else {
				watched[absolute] = true
			}
		}
		if libraryID == 0 {
			continue
		}
		dir, err := root.Open(folder)
		if err != nil {
			returnErr = errors.Join(returnErr, err)
			continue
		}
		entries, readErr := dir.ReadDir(-1)
		if err := errors.Join(readErr, dir.Close()); err != nil {
			returnErr = errors.Join(returnErr, err)
			continue
		}
		for _, entry := range entries {
			if ignored(entry.Name()) || !entry.Type().IsRegular() {
				continue
			}
			name := filepath.Join(folder, entry.Name())
			s.dropMu.Lock()
			queued := s.dropQueued[name]
			s.dropMu.Unlock()
			if queued {
				continue
			}
			info, err := s.dropInfo(name)
			if err != nil {
				continue
			}
			previous, exists := candidates[name]
			if !exists || previous.size != info.Size() || previous.mtime != info.ModTime().UnixNano() || previous.libraryID != libraryID {
				candidates[name] = candidate{size: info.Size(), mtime: info.ModTime().UnixNano(), stableSince: now, libraryID: libraryID}
			}
		}
	}
	return returnErr
}

func (s *Service) dropInfo(name string) (os.FileInfo, error) {
	if !filepath.IsLocal(name) || len(strings.Split(filepath.ToSlash(name), "/")) > 2 {
		return nil, errors.New("invalid drop path")
	}
	root, err := os.OpenRoot(s.options.DropDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if parent := filepath.Dir(name); parent != "." {
		info, err := root.Lstat(parent)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("drop folder is not a real directory")
		}
	}
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("drop source is not a regular file")
	}
	return info, nil
}

func (s *Service) queueDrop(ctx context.Context, name string, entry candidate) error {
	if s.options.SnapshotGate != nil {
		s.options.SnapshotGate.RLock()
		defer s.options.SnapshotGate.RUnlock()
	}
	queries := sqlc.New(s.options.Reader)
	var libraryErr error
	if parent := filepath.Dir(name); parent == "." {
		entry.libraryID, libraryErr = queries.ImportDefaultLibrary(ctx)
	} else {
		entry.libraryID, libraryErr = queries.ImportLibrarySlug(ctx, parent)
	}
	if libraryErr != nil {
		return libraryErr
	}
	before, err := s.dropInfo(name)
	if err != nil {
		return err
	}
	file, err := os.OpenInRoot(s.options.DropDir, name)
	if err != nil {
		return err
	}
	opened, statErr := file.Stat()
	if statErr != nil || !os.SameFile(before, opened) {
		return errors.Join(errors.New("drop source changed"), statErr, file.Close())
	}
	staged, stageErr := s.Stage(ctx, file)
	closeErr := file.Close()
	input := manifest{Staged: staged, DropPath: name, DropSize: entry.size, DropMtime: entry.mtime}
	if stageErr != nil || closeErr != nil {
		if ctx.Err() != nil {
			if stageErr == nil {
				return errors.Join(stageErr, closeErr, s.Discard(staged))
			}
			return errors.Join(stageErr, closeErr)
		}
		if stageErr != nil {
			input.Staged.Token = ""
		}
		input.Failure = s.safeError(errors.Join(stageErr, closeErr))
		_, err := s.enqueue(ctx, "drop_folder", entry.libraryID, 0, filepath.Base(name), input)
		if err != nil && stageErr == nil {
			return errors.Join(err, s.Discard(staged))
		}
		return err
	}
	after, err := s.dropInfo(name)
	if err != nil || !os.SameFile(before, after) || after.Size() != entry.size || after.ModTime().UnixNano() != entry.mtime {
		return errors.Join(errors.New("drop source changed while staging"), err, s.Discard(staged))
	}
	_, err = s.enqueue(ctx, "drop_folder", entry.libraryID, 0, filepath.Base(name), input)
	if err != nil {
		return errors.Join(err, s.Discard(staged))
	}
	return nil
}

func (s *Service) cleanupDrop(row sqlc.ImportJob, input manifest) (returnErr error) {
	info, err := s.dropInfo(input.DropPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Size() != input.DropSize || info.ModTime().UnixNano() != input.DropMtime {
		return errDropChanged
	}
	root, err := os.OpenRoot(s.options.DropDir)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	if row.Status == "imported" {
		return root.Remove(input.DropPath)
	}
	folder := ".failed"
	if row.Status == "duplicate" {
		folder = ".duplicates"
	}
	if err := root.MkdirAll(folder, 0o750); err != nil {
		return err
	}
	base := row.OriginalName
	if len(base) > 180 {
		base = strings.ToValidUTF8(base[:180], "")
	}
	destination := filepath.Join(folder, strconv.FormatInt(row.ID, 10)+"-"+base)
	if err := root.Link(input.DropPath, destination); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		existing, statErr := root.Lstat(destination)
		if statErr != nil || !os.SameFile(info, existing) {
			return errors.Join(errors.New("drop archive collision"), statErr)
		}
	}
	if row.Status == "failed" {
		errorFile, err := root.OpenFile(destination+".error.txt", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		if err == nil {
			_, writeErr := io.WriteString(errorFile, s.safeError(errors.New(row.Error.String))+"\n")
			if err := errors.Join(writeErr, errorFile.Sync(), errorFile.Close()); err != nil {
				return err
			}
		}
	}
	return root.Remove(input.DropPath)
}

func (s *Service) recoverManifests(ctx context.Context) error {
	entries, err := os.ReadDir(filepath.Join(s.options.DataDir, "tmp", "imports"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		id, err := strconv.ParseInt(strings.TrimSuffix(entry.Name(), ".json"), 10, 64)
		if err != nil || id < 1 || entry.IsDir() {
			continue
		}
		row, err := sqlc.New(s.options.Reader).ImportJob(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		input, err := s.readManifest(id)
		if err != nil {
			s.options.Logger.Error("read import recovery manifest", "job_id", id, "error", err)
			continue
		}
		if input.DropPath != "" {
			s.dropMu.Lock()
			s.dropQueued[input.DropPath] = true
			s.dropMu.Unlock()
		}
		if row.Status != "pending" && row.Status != "processing" {
			if s.hooks[row.Source] != nil {
				// Finished must run before cleanup removes the manifest; both run after Start.
				s.recovered = append(s.recovered, recoveredJob{row: row, input: input})
				continue
			}
			if err := s.cleanup(row, input); err != nil {
				s.options.Logger.Error("recover import cleanup", "job_id", id, "error", err)
			}
		}
	}
	return nil
}
