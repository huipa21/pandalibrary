package jobs

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"pandalibrary/internal/blobstore"
)

const (
	cleanupInterval      = time.Hour
	dailyInterval        = 24 * time.Hour
	checkpointInterval   = 5 * time.Minute
	maintenanceTimeout   = 5 * time.Minute
	tombstoneRetention   = 180 * 24 * time.Hour
	importRetention      = 30 * 24 * time.Hour
	orphanGracePeriod    = 24 * time.Hour
	backupRetention      = 7
	maxOrphanCandidates  = 1000
	maxOrphanScanEntries = 100000
)

type maintenanceJob struct {
	name     string
	interval time.Duration
	run      func(context.Context) error
}

// RunStatus describes the most recent run of one maintenance job.
type RunStatus struct {
	ID          string     `json:"id"`
	Status      string     `json:"status"`
	AcceptedAt  time.Time  `json:"accepted_at"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

// JobStatus describes a supported maintenance job and its most recent run.
type JobStatus struct {
	Name     string     `json:"name"`
	Schedule string     `json:"schedule"`
	Status   string     `json:"status"`
	LastRun  *RunStatus `json:"last_run"`
}

type jobState struct {
	job     maintenanceJob
	running bool
	lastRun *RunStatus
}

// Maintenance provides bounded maintenance tasks and their on-demand run state.
type Maintenance struct {
	writer  *sql.DB
	dataDir string
	dropDir string
	// guarded are extra user-content directories (such as the bookheap) that
	// must never overlap a storage root swept for orphans.
	guarded []string
	blobs   *blobstore.Store
	logger  *slog.Logger

	mu         sync.Mutex
	jobs       map[string]*jobState
	nextRun    uint64
	stopped    bool
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	registered bool
}

// NewMaintenance constructs the maintenance service without starting any work.
func NewMaintenance(parent context.Context, writer, reader *sql.DB, blobs *blobstore.Store, dataDir, dropDir string, logger *slog.Logger) (*Maintenance, error) {
	if parent == nil || writer == nil || reader == nil || blobs == nil || dataDir == "" || dropDir == "" || logger == nil {
		return nil, errors.New("maintenance requires a context, databases, data directory, and logger")
	}
	if err := parent.Err(); err != nil {
		return nil, err
	}
	absoluteDir, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("resolve maintenance data directory: %w", err)
	}
	absoluteDrop, err := filepath.Abs(dropDir)
	if err != nil {
		return nil, fmt.Errorf("resolve maintenance drop directory: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(absoluteDrop); err == nil {
		absoluteDrop = resolved
	} else if !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("resolve maintenance drop directory links: %w", err)
	}
	ctx, cancel := context.WithCancel(parent)
	service := &Maintenance{
		writer: writer, blobs: blobs, dataDir: absoluteDir, dropDir: absoluteDrop, logger: logger,
		jobs: make(map[string]*jobState), ctx: ctx, cancel: cancel,
	}
	for _, job := range []maintenanceJob{
		{name: "cleanup-expired", interval: cleanupInterval, run: service.cleanupExpired},
		{name: "backup", interval: dailyInterval, run: service.backup},
		{name: "orphan-sweep", interval: dailyInterval, run: service.sweepOrphans},
		{name: "optimize", interval: dailyInterval, run: service.optimize},
		{name: "fts-check", interval: dailyInterval, run: service.checkFTS},
		{name: "wal-checkpoint", interval: checkpointInterval, run: service.checkpoint},
	} {
		service.jobs[job.name] = &jobState{job: job}
	}
	return service, nil
}

// Register adds all maintenance tasks to the scheduler before it starts.
func (m *Maintenance) Register(scheduler *Scheduler) error {
	if scheduler == nil {
		return errors.New("maintenance scheduler must not be nil")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.registered {
		return errors.New("maintenance jobs are already registered")
	}
	if m.stopped || m.ctx.Err() != nil {
		return errors.New("maintenance is stopped")
	}
	jobs := make([]maintenanceJob, 0, len(m.jobs))
	for _, state := range m.jobs {
		jobs = append(jobs, state.job)
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].name < jobs[j].name })
	for _, job := range jobs {
		name := job.name
		if err := scheduler.Register(name, job.interval, func(ctx context.Context) error {
			return m.runScheduled(ctx, name)
		}); err != nil {
			return fmt.Errorf("register maintenance job %q: %w", name, err)
		}
	}
	m.registered = true
	return nil
}

// Jobs returns supported jobs and the status of each job's most recent run.
func (m *Maintenance) Jobs() []JobStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.jobs))
	for name := range m.jobs {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]JobStatus, 0, len(names))
	for _, name := range names {
		state := m.jobs[name]
		status := "idle"
		if state.lastRun != nil {
			status = state.lastRun.Status
		}
		entry := JobStatus{Name: name, Schedule: state.job.interval.String(), Status: status}
		if state.lastRun != nil {
			copy := *state.lastRun
			entry.LastRun = &copy
		}
		result = append(result, entry)
	}
	return result
}

var (
	ErrUnknownJob = errors.New("unknown maintenance job")
	ErrJobRunning = errors.New("maintenance job is already running")
	ErrJobStopped = errors.New("maintenance service is stopped")
)

// RunNow accepts one on-demand run, returning ErrJobRunning when it would overlap.
func (m *Maintenance) RunNow(name string) (RunStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, ok := m.jobs[name]
	if !ok {
		return RunStatus{}, ErrUnknownJob
	}
	if m.stopped || m.ctx.Err() != nil {
		return RunStatus{}, ErrJobStopped
	}
	if !m.registered {
		return RunStatus{}, ErrJobStopped
	}
	if state.running {
		return RunStatus{}, ErrJobRunning
	}
	m.nextRun++
	run := &RunStatus{
		ID: fmt.Sprintf("%s-%d", name, m.nextRun), Status: "accepted", AcceptedAt: time.Now().UTC(),
	}
	state.running = true
	state.lastRun = run
	m.wg.Add(1)
	go m.runManual(name, run.ID)
	return *run, nil
}

func (m *Maintenance) runManual(name, runID string) {
	defer m.wg.Done()
	if err := m.execute(name, m.ctx, runID); err != nil {
		m.logger.Error("manual maintenance job failed", "job", name, "run_id", runID, "error", err)
	}
}

func (m *Maintenance) runScheduled(ctx context.Context, name string) error {
	m.mu.Lock()
	state, ok := m.jobs[name]
	if !ok {
		m.mu.Unlock()
		return ErrUnknownJob
	}
	if m.stopped || m.ctx.Err() != nil || ctx.Err() != nil {
		m.mu.Unlock()
		return nil
	}
	if state.running {
		m.mu.Unlock()
		return nil
	}
	m.nextRun++
	runID := fmt.Sprintf("%s-%d", name, m.nextRun)
	state.running = true
	state.lastRun = &RunStatus{ID: runID, Status: "accepted", AcceptedAt: time.Now().UTC()}
	m.wg.Add(1)
	m.mu.Unlock()
	defer m.wg.Done()
	return m.execute(name, ctx, runID)
}

func (m *Maintenance) execute(name string, parent context.Context, runID string) error {
	m.mu.Lock()
	state := m.jobs[name]
	if state == nil {
		m.mu.Unlock()
		return ErrUnknownJob
	}
	if state.lastRun != nil && state.lastRun.ID == runID && state.lastRun.Status == "accepted" {
		started := time.Now().UTC()
		state.lastRun.StartedAt = &started
		state.lastRun.Status = "running"
	}
	job := state.job
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(parent, maintenanceTimeout)
	stopCancellation := context.AfterFunc(m.ctx, cancel)
	if m.ctx.Err() != nil {
		cancel()
	}
	err := ctx.Err()
	if err == nil {
		err = job.run(ctx)
	}
	stopCancellation()
	cancel()
	completed := time.Now().UTC()
	m.mu.Lock()
	if state := m.jobs[name]; state != nil && state.lastRun != nil && state.lastRun.ID == runID {
		state.running = false
		state.lastRun.CompletedAt = &completed
		if err != nil {
			state.lastRun.Status = "error"
		} else {
			state.lastRun.Status = "completed"
		}
	}
	m.mu.Unlock()
	return err
}

// Stop cancels maintenance work and waits until accepted runs have exited.
func (m *Maintenance) Stop(ctx context.Context) error {
	m.mu.Lock()
	m.stopped = true
	m.cancel()
	m.mu.Unlock()
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("stop maintenance: %w", ctx.Err())
	}
}

func (m *Maintenance) cleanupExpired(ctx context.Context) error {
	return m.cleanupExpiredAt(ctx, time.Now().UTC())
}

func (m *Maintenance) cleanupExpiredAt(ctx context.Context, instant time.Time) error {
	now := instant.UnixMilli()
	importCutoff := instant.Add(-importRetention).UnixMilli()
	tombstoneCutoff := instant.Add(-tombstoneRetention).UnixMilli()
	tx, err := m.writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin expired-state cleanup: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, now); err != nil {
		return rollback(tx, fmt.Errorf("delete expired sessions: %w", err))
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM metadata_cache WHERE expires_at <= ?`, now); err != nil {
		return rollback(tx, fmt.Errorf("delete expired metadata cache: %w", err))
	}
	if err := m.pruneImportHistory(ctx, tx, importCutoff); err != nil {
		return rollback(tx, fmt.Errorf("prune completed import history: %w", err))
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM notes_fts
		WHERE rowid IN (SELECT seq FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?)
	`, tombstoneCutoff); err != nil {
		return rollback(tx, fmt.Errorf("remove expired note search entries: %w", err))
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?
	`, tombstoneCutoff); err != nil {
		return rollback(tx, fmt.Errorf("prune note tombstones: %w", err))
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM highlights_fts
		WHERE rowid IN (
			SELECT h.seq FROM highlights h
			WHERE h.deleted_at IS NOT NULL AND h.deleted_at < ?
			AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.highlight_id = h.id)
		)
	`, tombstoneCutoff); err != nil {
		return rollback(tx, fmt.Errorf("remove expired highlight search entries: %w", err))
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM highlights
		WHERE deleted_at IS NOT NULL AND deleted_at < ?
		AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.highlight_id = highlights.id)
	`, tombstoneCutoff); err != nil {
		return rollback(tx, fmt.Errorf("prune highlight tombstones: %w", err))
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM bookmarks WHERE deleted_at IS NOT NULL AND deleted_at < ?
	`, tombstoneCutoff); err != nil {
		return rollback(tx, fmt.Errorf("prune bookmark tombstones: %w", err))
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM page_annotations WHERE deleted_at IS NOT NULL AND deleted_at < ?
	`, tombstoneCutoff); err != nil {
		return rollback(tx, fmt.Errorf("prune page annotation tombstones: %w", err))
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit expired-state cleanup: %w", err)
	}
	return nil
}

func (m *Maintenance) pruneImportHistory(ctx context.Context, tx *sql.Tx, cutoff int64) (returnErr error) {
	// Keep the highest ID: SQLite INTEGER PRIMARY KEY otherwise reuses purged job IDs.
	rows, err := tx.QueryContext(ctx, `
		SELECT id FROM import_jobs
		WHERE created_at < ? AND status IN ('imported', 'duplicate', 'failed')
		AND id < (SELECT max(id) FROM import_jobs)
		ORDER BY id LIMIT 1000
	`, cutoff)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return errors.Join(err, rows.Close())
		}
		ids = append(ids, id)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	root, err := os.OpenRoot(m.dataDir)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return err
		}
		manifest := filepath.Join("tmp", "imports", strconv.FormatInt(id, 10)+".json")
		if _, err := root.Lstat(manifest); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("inspect retained import manifest: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM import_jobs WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return nil
}

func rollback(tx *sql.Tx, cause error) error {
	if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		return errors.Join(cause, fmt.Errorf("roll back maintenance transaction: %w", err))
	}
	return cause
}

func (m *Maintenance) checkpoint(ctx context.Context) error {
	var busy, logFrames, checkpointed int
	if err := m.writer.QueryRowContext(ctx, `PRAGMA wal_checkpoint(PASSIVE)`).Scan(
		&busy, &logFrames, &checkpointed,
	); err != nil {
		return fmt.Errorf("run passive WAL checkpoint: %w", err)
	}
	return nil
}

func (m *Maintenance) optimize(ctx context.Context) error {
	rows, err := m.writer.QueryContext(ctx, `PRAGMA optimize`)
	if err != nil {
		return fmt.Errorf("run SQLite optimize: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read SQLite optimize result: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close SQLite optimize result: %w", err)
	}
	return nil
}

func (m *Maintenance) checkFTS(ctx context.Context) error {
	for _, table := range []string{"books_fts", "highlights_fts", "notes_fts"} {
		if err := ctx.Err(); err != nil {
			return err
		}
		statement := fmt.Sprintf(`INSERT INTO %s(%s) VALUES('integrity-check')`, table, table)
		if _, err := m.writer.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("FTS consistency check failed for %s: %w", table, err)
		}
	}
	return nil
}

func (m *Maintenance) backup(ctx context.Context) (returnErr error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := os.OpenRoot(m.dataDir)
	if err != nil {
		return fmt.Errorf("open data directory for backup: %w", err)
	}
	defer func() {
		if err := root.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close backup data root: %w", err))
		}
	}()
	if err := root.MkdirAll("backups", 0o750); err != nil {
		return fmt.Errorf("create backup directory: %w", err)
	}
	info, err := root.Lstat("backups")
	if err != nil {
		return fmt.Errorf("inspect backup directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return errors.New("backup directory is not a regular directory")
	}
	backupRoot, err := root.OpenRoot("backups")
	if err != nil {
		return fmt.Errorf("open backup directory: %w", err)
	}
	defer func() {
		if err := backupRoot.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close backup directory: %w", err))
		}
	}()

	filename, err := backupFilename()
	if err != nil {
		return err
	}
	if _, err := backupRoot.Lstat(filename); err == nil {
		return errors.New("refusing to overwrite an existing backup")
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("inspect backup destination: %w", err)
	}
	temporary := filename + ".partial"
	file, err := backupRoot.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("reserve backup destination: %w", err)
	}
	if err := file.Close(); err != nil {
		return errors.Join(err, backupRoot.Remove(temporary))
	}
	defer func() {
		if err := backupRoot.Remove(temporary); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("remove temporary backup: %w", err))
		}
	}()
	destination := filepath.Join(m.dataDir, "backups", temporary)
	// SQLite accepts a bound filename and only writes an absent or empty destination.
	if _, err := m.writer.ExecContext(ctx, `VACUUM INTO ?`, destination); err != nil {
		return fmt.Errorf("create online database backup: %w", err)
	}
	backupInfo, err := backupRoot.Lstat(temporary)
	if err != nil {
		return fmt.Errorf("verify backup file: %w", err)
	}
	if !backupInfo.Mode().IsRegular() || backupInfo.Size() == 0 {
		return errors.New("database backup is not a non-empty regular file")
	}
	if err := verifyBackup(ctx, destination); err != nil {
		return err
	}
	completedFile, err := backupRoot.OpenFile(temporary, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("open backup for disk sync: %w", err)
	}
	if err := errors.Join(completedFile.Sync(), completedFile.Close()); err != nil {
		return fmt.Errorf("sync completed backup to disk: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := backupRoot.Link(temporary, filename); err != nil {
		return fmt.Errorf("publish verified backup without overwrite: %w", err)
	}
	if err := m.pruneBackups(ctx, backupRoot); err != nil {
		return err
	}
	return nil
}

func backupFilename() (string, error) {
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("generate unique backup name: %w", err)
	}
	return "maintenance-" + time.Now().UTC().Format("20060102T150405.000000000Z") +
		"-" + hex.EncodeToString(nonce[:]) + ".db", nil
}

func verifyBackup(ctx context.Context, path string) (returnErr error) {
	uri := url.URL{Scheme: "file", Path: filepath.ToSlash(path), RawQuery: "mode=ro"}
	if filepath.VolumeName(path) != "" && !strings.HasPrefix(uri.Path, "/") {
		uri.Path = "/" + uri.Path
	}
	database, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return fmt.Errorf("open completed backup for verification: %w", err)
	}
	database.SetMaxOpenConns(1)
	defer func() {
		if err := database.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close verified backup: %w", err))
		}
	}()
	var result string
	if err := database.QueryRowContext(ctx, `PRAGMA quick_check`).Scan(&result); err != nil {
		return fmt.Errorf("check completed backup integrity: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("completed backup failed SQLite integrity check: %s", result)
	}
	return nil
}

func (m *Maintenance) pruneBackups(ctx context.Context, root *os.Root) error {
	entries, err := readDirectory(ctx, root, ".", maxOrphanScanEntries)
	if err != nil {
		return fmt.Errorf("list maintenance backups: %w", err)
	}
	type backupEntry struct {
		name string
		time time.Time
	}
	var backups []backupEntry
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() || !isMaintenanceBackupName(entry.Name()) {
			continue
		}
		info, err := root.Lstat(entry.Name())
		if err != nil {
			return fmt.Errorf("inspect retained backup: %w", err)
		}
		if !info.Mode().IsRegular() {
			continue
		}
		backups = append(backups, backupEntry{name: entry.Name(), time: info.ModTime()})
	}
	sort.Slice(backups, func(i, j int) bool {
		if backups[i].time.Equal(backups[j].time) {
			return backups[i].name > backups[j].name
		}
		return backups[i].time.After(backups[j].time)
	})
	for _, backup := range backups[min(backupRetention, len(backups)):] {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := root.Remove(backup.name); err != nil {
			return fmt.Errorf("remove expired maintenance backup: %w", err)
		}
	}
	return nil
}

func isMaintenanceBackupName(name string) bool {
	if !strings.HasPrefix(name, "maintenance-") || !strings.HasSuffix(name, ".db") {
		return false
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(name, "maintenance-"), ".db"), "-")
	if len(parts) != 2 || len(parts[1]) != 16 {
		return false
	}
	if _, err := time.Parse("20060102T150405.000000000Z", parts[0]); err != nil {
		return false
	}
	_, err := hex.DecodeString(parts[1])
	return err == nil
}

func (m *Maintenance) sweepOrphans(ctx context.Context) (returnErr error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := os.OpenRoot(m.dataDir)
	if err != nil {
		return fmt.Errorf("open data directory for orphan sweep: %w", err)
	}
	defer func() {
		if err := root.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close orphan sweep data root: %w", err))
		}
	}()
	remaining := maxOrphanScanEntries
	removed := 0
	cutoff := time.Now().Add(-orphanGracePeriod)
	for _, category := range []string{"files", "covers"} {
		if err := ctx.Err(); err != nil {
			return err
		}
		storagePath, err := filepath.EvalSymlinks(filepath.Join(m.dataDir, category))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("resolve orphan storage root: %w", err)
		}
		if pathsOverlap(storagePath, m.dropDir) {
			m.logger.Warn("orphan storage root overlaps configured drop directory; skipping sweep", "storage", category)
			continue
		}
		if m.overlapsGuarded(storagePath) {
			m.logger.Warn("orphan storage root overlaps a guarded content directory; skipping sweep", "storage", category)
			continue
		}
		storage, err := openStorageDirectory(root, category)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("open %s storage root: %w", category, err)
		}
		scanErr := m.sweepStorage(ctx, storage, category, cutoff, &remaining, &removed)
		if err := errors.Join(scanErr, storage.Close()); err != nil {
			return fmt.Errorf("sweep %s storage: %w", category, err)
		}
		if removed >= maxOrphanCandidates {
			break
		}
	}
	return nil
}

// GuardDirectory registers a user-content directory (for example the bookheap)
// that the orphan sweep must never treat as, or overlap with, a storage root.
func (m *Maintenance) GuardDirectory(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve guarded directory: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = resolved
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("resolve guarded directory links: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.guarded = append(m.guarded, absolute)
	return nil
}

func (m *Maintenance) overlapsGuarded(storagePath string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, guarded := range m.guarded {
		if pathsOverlap(storagePath, guarded) {
			return true
		}
	}
	return false
}

func pathsOverlap(a, b string) bool {
	for _, pair := range [][2]string{{a, b}, {b, a}} {
		if relative, err := filepath.Rel(pair[0], pair[1]); err == nil &&
			(relative == "." || filepath.IsLocal(relative)) {
			return true
		}
	}
	return false
}

func openStorageDirectory(parent *os.Root, name string) (*os.Root, error) {
	before, err := parent.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || before.Mode()&fs.ModeSymlink != 0 {
		return nil, fmt.Errorf("%s is not a non-symlink storage directory", name)
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	after, err := root.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		return nil, errors.Join(errors.New("storage directory changed while opening"), err, root.Close())
	}
	return root, nil
}

func readDirectory(ctx context.Context, root *os.Root, name string, limit int) ([]os.DirEntry, error) {
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	var entries []os.DirEntry
	for {
		if err := ctx.Err(); err != nil {
			return nil, errors.Join(err, file.Close())
		}
		batch, readErr := file.ReadDir(min(256, limit-len(entries)+1))
		entries = append(entries, batch...)
		if len(entries) > limit {
			return nil, errors.Join(errors.New("maintenance directory scan limit exceeded"), file.Close())
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, errors.Join(readErr, file.Close())
		}
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, nil
}

func (m *Maintenance) sweepStorage(ctx context.Context, storage *os.Root, category string, cutoff time.Time, remaining, removed *int) error {
	shards, err := readDirectory(ctx, storage, ".", maxOrphanScanEntries)
	if err != nil {
		return err
	}
	for _, entry := range shards {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !validShard(entry.Name()) || !entry.IsDir() || entry.Type()&fs.ModeSymlink != 0 {
			continue
		}
		shard, err := openStorageDirectory(storage, entry.Name())
		if err != nil {
			return err
		}
		scanErr := m.sweepShard(ctx, shard, category, entry.Name(), cutoff, remaining, removed)
		if err := errors.Join(scanErr, shard.Close()); err != nil {
			return err
		}
		if *removed >= maxOrphanCandidates {
			break
		}
	}
	return nil
}

func (m *Maintenance) sweepShard(ctx context.Context, root *os.Root, category, shard string, cutoff time.Time, remaining, removed *int) error {
	entries, err := readDirectory(ctx, root, ".", *remaining)
	if err != nil {
		return err
	}
	*remaining -= len(entries)
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		hash, kind, ok := parseStoredName(category, shard, entry.Name())
		if !ok {
			continue
		}
		info, err := root.Lstat(entry.Name())
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || !info.ModTime().Before(cutoff) {
			continue
		}
		deleted, err := m.removeOrphan(ctx, root, entry.Name(), hash, kind, cutoff)
		if err != nil {
			return err
		}
		if deleted {
			*removed++
		}
		if *removed >= maxOrphanCandidates {
			break
		}
	}
	return nil
}

func (m *Maintenance) removeOrphan(ctx context.Context, root *os.Root, name, hash, kind string, cutoff time.Time) (bool, error) {
	tx, err := m.writer.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin orphan reference check: %w", err)
	}
	var referenced bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM book_files WHERE sha256 = ?)
			OR EXISTS(SELECT 1 FROM books WHERE cover_sha256 = ?)
			OR (? = 'cover' AND EXISTS(SELECT 1 FROM bookheap_items WHERE cover_sha256 = ?))
			OR EXISTS(SELECT 1 FROM import_jobs WHERE status IN ('pending', 'processing')
				AND (? = 'cover' OR sha256 = ?))
	`, hash, hash, kind, hash, kind, hash).Scan(&referenced); err != nil {
		return false, rollback(tx, fmt.Errorf("check orphan references: %w", err))
	}
	deleted := false
	if !referenced {
		err := m.blobs.WithPublicationLock(ctx, func() error {
			info, err := root.Lstat(name)
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
			if err == nil && info.Mode().IsRegular() && info.ModTime().Before(cutoff) {
				if err := ctx.Err(); err != nil {
					return err
				}
				if err := root.Remove(name); err != nil {
					return fmt.Errorf("remove confirmed orphan: %w", err)
				}
				deleted = true
			}
			return nil
		})
		if err != nil {
			return false, rollback(tx, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return deleted, fmt.Errorf("commit orphan reference check: %w", err)
	}
	return deleted, nil
}

func validShard(name string) bool {
	if len(name) != 2 {
		return false
	}
	for _, char := range name {
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func parseStoredName(category, shard, name string) (hash, kind string, ok bool) {
	switch category {
	case "files":
		hash, format, found := strings.Cut(name, ".")
		if !found || !blobstore.ValidHash(hash) || hash[:2] != shard {
			return "", "", false
		}
		switch format {
		case "epub", "pdf", "mobi", "azw3", "fb2", "fbz", "cbz":
			return hash, "book", true
		default:
			return "", "", false
		}
	case "covers":
		if strings.HasSuffix(name, "-w400.jpg") {
			hash = strings.TrimSuffix(name, "-w400.jpg")
		} else if strings.HasSuffix(name, ".jpg") {
			hash = strings.TrimSuffix(name, ".jpg")
		} else {
			return "", "", false
		}
		if !blobstore.ValidHash(hash) || hash[:2] != shard {
			return "", "", false
		}
		return hash, "cover", true
	default:
		return "", "", false
	}
}
