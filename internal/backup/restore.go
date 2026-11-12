package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

const journalName = ".restore-journal.json"

type replacement struct {
	Target string `json:"target"`
	New    string `json:"new"`
	Old    string `json:"old"`
	HadOld bool   `json:"had_old"`
}

type journal struct {
	Committed bool          `json:"committed"`
	Entries   []replacement `json:"entries"`
}

// ApplyPending must run with the process data lock held, before SQLite or any
// worker opens data. An interrupted replacement is rolled back on the next start.
func (s *Service) ApplyPending(ctx context.Context) (returnErr error) {
	if err := s.prepare(); err != nil {
		return err
	}
	journalPath := filepath.Join(s.directory(), journalName)
	data, err := os.ReadFile(journalPath)
	if err == nil {
		var j journal
		if err := json.Unmarshal(data, &j); err != nil {
			return fmt.Errorf("read restore recovery journal: %w", err)
		}
		if err := s.recover(j); err != nil {
			return fmt.Errorf("recover interrupted restore: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	pending := filepath.Join(s.directory(), pendingName)
	info, err := os.Lstat(pending)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("pending restore must be a regular archive")
	}
	work, err := os.MkdirTemp(s.directory(), ".apply-")
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, os.RemoveAll(work)) }()
	if err := s.validate(ctx, pending, filepath.Join(work, "data")); err != nil {
		return fmt.Errorf("pending restore rejected; live data unchanged: %w", err)
	}
	j := journal{}
	targets := []string{"pandalibrary.db", "pandalibrary.db-wal", "pandalibrary.db-shm", "pandalibrary.db-journal"}
	targets = append(targets, roots...)
	id := token()
	for _, name := range targets {
		target := filepath.Join(s.DataDir, name)
		if dir, ok := s.Dirs[name]; ok {
			target = dir
		}
		// Prepare siblings so every replacement uses same-filesystem rename,
		// including externally configured drop and bookheap directories.
		parent := filepath.Dir(target)
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return err
		}
		if err := realDirectory(parent); err != nil {
			return err
		}
		info, err := os.Lstat(target)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return errors.New("restore refuses a symlink target")
		}
		entry := replacement{
			Target: target,
			New:    filepath.Join(parent, ".panda-new-"+id+"-"+filepath.Base(target)),
			Old:    filepath.Join(parent, ".panda-old-"+id+"-"+filepath.Base(target)),
			HadOld: err == nil,
		}
		j.Entries = append(j.Entries, entry)
	}
	// All preparations are recorded before any live path is moved. Failed
	// preparations are also recoverable and do not leave unknown sibling files.
	if err := s.saveJournal(j); err != nil {
		return err
	}
	fail := func(cause error) error {
		return errors.Join(cause, s.recover(j))
	}
	for i, name := range targets {
		source := filepath.Join(work, "data", name)
		if _, err := os.Stat(source); errors.Is(err, os.ErrNotExist) {
			continue // WAL/SHM/journal must not survive the database replacement.
		} else if err != nil {
			return fail(err)
		}
		if err := copyTree(ctx, source, j.Entries[i].New); err != nil {
			return fail(fmt.Errorf("prepare restore %s: %w", name, err))
		}
	}
	for _, entry := range j.Entries {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		if entry.HadOld {
			if err := os.Rename(entry.Target, entry.Old); err != nil {
				return fail(err)
			}
			if err := syncDirectory(filepath.Dir(entry.Target)); err != nil {
				return fail(err)
			}
		}
		if _, err := os.Lstat(entry.New); err == nil {
			if err := os.Rename(entry.New, entry.Target); err != nil {
				return fail(err)
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return fail(err)
		}
		if err := syncDirectory(filepath.Dir(entry.Target)); err != nil {
			return fail(err)
		}
	}
	j.Committed = true
	if err := s.saveJournal(j); err != nil {
		// The rename may have succeeded even if directory fsync failed. Do not
		// roll back using an in-memory state that might disagree with disk.
		return fmt.Errorf("commit restore journal; startup recovery required: %w", err)
	}
	return s.recover(j)
}

func (s *Service) saveJournal(j journal) error {
	data, err := json.Marshal(j)
	if err != nil {
		return err
	}
	name := filepath.Join(s.directory(), journalName)
	file, err := os.OpenFile(name+".new", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		return err
	}
	if err := os.Rename(name+".new", name); err != nil {
		return err
	}
	return syncDirectory(s.directory())
}

func (s *Service) recover(j journal) error {
	if j.Committed {
		if err := os.Remove(filepath.Join(s.directory(), pendingName)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for i := len(j.Entries) - 1; i >= 0; i-- {
		entry := j.Entries[i]
		if !j.Committed {
			if _, err := os.Lstat(entry.Old); err == nil {
				if err := os.RemoveAll(entry.Target); err != nil {
					return err
				}
				if err := os.Rename(entry.Old, entry.Target); err != nil {
					return err
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				return err
			} else if !entry.HadOld {
				if err := os.RemoveAll(entry.Target); err != nil {
					return err
				}
			}
		}
		if err := errors.Join(os.RemoveAll(entry.New), os.RemoveAll(entry.Old), syncDirectory(filepath.Dir(entry.Target))); err != nil {
			return err
		}
	}
	if err := os.Remove(filepath.Join(s.directory(), journalName)); err != nil {
		return err
	}
	return syncDirectory(s.directory())
}

func copyTree(ctx context.Context, source, destination string) error {
	var directories []string
	err := filepath.WalkDir(source, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, name)
		if err != nil {
			return err
		}
		target := destination
		if rel != "." {
			target = filepath.Join(destination, rel)
		}
		if entry.IsDir() {
			directories = append(directories, target)
			return os.Mkdir(target, 0o700)
		}
		if !entry.Type().IsRegular() {
			return ErrInvalid
		}
		input, err := os.Open(name)
		if err != nil {
			return err
		}
		defer input.Close()
		info, err := input.Stat()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(output, contextReader{ctx, input})
		if err := errors.Join(copyErr, output.Sync(), output.Close()); err != nil {
			return err
		}
		return os.Chtimes(target, info.ModTime(), info.ModTime())
	})
	if err != nil {
		return err
	}
	for i := len(directories) - 1; i >= 0; i-- {
		if err := syncDirectory(directories[i]); err != nil {
			return err
		}
	}
	return nil
}
