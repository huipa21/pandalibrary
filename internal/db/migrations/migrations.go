package migrations

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pressly/goose/v3"
)

//go:embed *.sql *.sum
var embedded embed.FS

var migrationFilePattern = regexp.MustCompile(`^(\d{5})_.+\.(sql|go)$`)

// GoMigrations explicitly lists registered Go migrations in version order.
var GoMigrations = []*goose.Migration{}

// Options controls automatic migration behavior and post-migration hooks.
type Options struct {
	AutoMigrate     bool
	Backup          bool
	ReadEnvironment bool
	BackupDir       string
	GoMigrations    []*goose.Migration
	Actions         []PostMigrationAction
	Now             func() time.Time
}

// DefaultOptions enables automatic migrations and pre-migration backups.
func DefaultOptions() Options {
	return Options{AutoMigrate: true, Backup: true, ReadEnvironment: true, Now: time.Now}
}

// PostMigrationAction runs transactionally when its server_settings flag exists.
type PostMigrationAction struct {
	Key string
	Run func(context.Context, *sql.Tx) error
}

// Runner applies and reports the embedded migrations.
type Runner struct {
	provider *goose.Provider
	writer   *sql.DB
	path     string
	options  Options
}

// Files returns the immutable migration assets embedded in the binary.
func Files() fs.FS {
	return embedded
}

// NewRunner creates a runner for the supplied writer and migration filesystem.
func NewRunner(writer *sql.DB, databasePath string, files fs.FS, options Options) (*Runner, error) {
	if writer == nil {
		return nil, errors.New("writer database must not be nil")
	}
	if files == nil {
		files = embedded
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.ReadEnvironment {
		var err error
		options.AutoMigrate, err = envBool("PANDA_AUTO_MIGRATE", options.AutoMigrate)
		if err != nil {
			return nil, err
		}
		options.Backup, err = envBool("PANDA_MIGRATE_BACKUP", options.Backup)
		if err != nil {
			return nil, err
		}
	}
	if options.BackupDir == "" && databasePath != "" && databasePath != ":memory:" {
		options.BackupDir = filepath.Join(filepath.Dir(databasePath), "backups")
	}
	goMigrations := options.GoMigrations
	if goMigrations == nil {
		goMigrations = GoMigrations
	}
	if err := validateMigrationVersions(files, goMigrations); err != nil {
		return nil, err
	}
	if err := verifySum(files); err != nil {
		return nil, err
	}
	provider, err := goose.NewProvider(
		goose.DialectSQLite3,
		writer,
		files,
		goose.WithDisableGlobalRegistry(true),
		goose.WithGoMigrations(goMigrations...),
	)
	if err != nil {
		return nil, fmt.Errorf("create migration provider: %w", err)
	}
	return &Runner{provider: provider, writer: writer, path: databasePath, options: options}, nil
}

// Run applies pending migrations according to AutoMigrate and runs pending actions.
func (r *Runner) Run(ctx context.Context) error {
	current, latest, err := r.provider.GetVersions(ctx)
	if err != nil {
		return fmt.Errorf("read migration versions: %w", err)
	}
	if current > latest {
		return newerDatabaseError(current, latest)
	}
	backupPath := ""
	if current < latest {
		if !r.options.AutoMigrate {
			return fmt.Errorf("database migration %d is behind binary version %d; run 'pandalibrary migrate up'", current, latest)
		}
		if backupPath, err = r.applyUp(ctx, current, latest); err != nil {
			return err
		}
	} else if err := checkIntegrity(ctx, r.writer); err != nil {
		return fmt.Errorf("database integrity check: %w", err)
	}
	if err := r.runActions(ctx); err != nil {
		return backupFailureContext(backupPath, err)
	}
	return nil
}

// Up explicitly applies pending migrations regardless of the startup auto-migrate setting.
func (r *Runner) Up(ctx context.Context) error {
	current, latest, err := r.provider.GetVersions(ctx)
	if err != nil {
		return fmt.Errorf("read migration versions: %w", err)
	}
	if current > latest {
		return newerDatabaseError(current, latest)
	}
	backupPath := ""
	if current < latest {
		if backupPath, err = r.applyUp(ctx, current, latest); err != nil {
			return err
		}
	} else if err := checkIntegrity(ctx, r.writer); err != nil {
		return fmt.Errorf("database integrity check: %w", err)
	}
	if err := r.runActions(ctx); err != nil {
		return backupFailureContext(backupPath, err)
	}
	return nil
}

// Status returns the current and target migration versions.
func (r *Runner) Status(ctx context.Context) (current, latest int64, err error) {
	current, latest, err = r.provider.GetVersions(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("read migration versions: %w", err)
	}
	return current, latest, nil
}

// DownTo rolls back migrations to version, intended for development databases only.
func (r *Runner) DownTo(ctx context.Context, version int64) error {
	if version < 0 {
		return fmt.Errorf("migration version must be zero or greater: %d", version)
	}
	current, latest, err := r.provider.GetVersions(ctx)
	if err != nil {
		return fmt.Errorf("read migration versions: %w", err)
	}
	if current > latest {
		return newerDatabaseError(current, latest)
	}
	if version > current {
		return fmt.Errorf("target migration version %d is newer than current version %d", version, current)
	}
	if version > latest {
		return fmt.Errorf("target migration version %d is newer than this binary's latest version %d", version, latest)
	}
	if _, err := r.provider.DownTo(ctx, version); err != nil {
		return fmt.Errorf("migrate down to %d: %w", version, err)
	}
	if err := checkIntegrity(ctx, r.writer); err != nil {
		return fmt.Errorf("post-migration integrity check: %w", err)
	}
	return nil
}

func (r *Runner) applyUp(ctx context.Context, current, latest int64) (string, error) {
	backupPath := ""
	empty, err := databaseIsEmpty(ctx, r.writer)
	if err != nil {
		return "", fmt.Errorf("check whether database is empty: %w", err)
	}
	if r.options.Backup && !empty {
		backupPath, err = r.backup(ctx, current, latest)
		if err != nil {
			return "", err
		}
	}
	if _, err := r.provider.Up(ctx); err != nil {
		return backupPath, backupFailureContext(backupPath, fmt.Errorf("apply migrations: %w", err))
	}
	if err := checkIntegrity(ctx, r.writer); err != nil {
		return backupPath, backupFailureContext(backupPath, fmt.Errorf("post-migration integrity check: %w", err))
	}
	return backupPath, nil
}

func (r *Runner) backup(ctx context.Context, current, latest int64) (string, error) {
	if r.path == "" || r.path == ":memory:" {
		return "", errors.New("cannot create a pre-migration backup without a database file path")
	}
	if r.options.BackupDir == "" {
		return "", errors.New("backup directory must not be empty")
	}
	if err := os.MkdirAll(r.options.BackupDir, 0o755); err != nil {
		return "", fmt.Errorf("create backup directory %q: %w", r.options.BackupDir, err)
	}
	name := fmt.Sprintf(
		"pre-migrate-v%d-v%d-%s.db",
		current,
		latest,
		r.options.Now().UTC().Format("20060102T150405.000000000Z"),
	)
	path := filepath.Join(r.options.BackupDir, name)
	escapedPath := strings.ReplaceAll(filepath.ToSlash(path), "'", "''")
	if _, err := r.writer.ExecContext(ctx, "VACUUM INTO '"+escapedPath+"'"); err != nil {
		return "", fmt.Errorf("create pre-migration backup %q: %w", path, err)
	}
	return path, nil
}

func (r *Runner) runActions(ctx context.Context) error {
	for _, action := range r.options.Actions {
		if action.Key == "" || action.Run == nil {
			return errors.New("post-migration action requires a key and callback")
		}
		err := withActionTx(ctx, r.writer, action)
		if err != nil {
			return fmt.Errorf("post-migration action %q failed; pending flag was retained: %w", action.Key, err)
		}
	}
	return nil
}

func withActionTx(ctx context.Context, writer *sql.DB, action PostMigrationAction) error {
	tx, err := writer.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin action transaction: %w", err)
	}
	var exists int
	err = tx.QueryRowContext(ctx, "SELECT 1 FROM server_settings WHERE key = ?", action.Key).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			return fmt.Errorf("rollback action transaction: %w", rollbackErr)
		}
		return nil
	}
	if err != nil {
		rollbackErr := tx.Rollback()
		actionErr := fmt.Errorf("read pending action flag: %w", err)
		if rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			actionErr = errors.Join(actionErr, fmt.Errorf("rollback action transaction: %w", rollbackErr))
		}
		return actionErr
	}
	if err := action.Run(ctx, tx); err != nil {
		rollbackErr := tx.Rollback()
		if rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			return errors.Join(err, fmt.Errorf("rollback action transaction: %w", rollbackErr))
		}
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM server_settings WHERE key = ?", action.Key); err != nil {
		rollbackErr := tx.Rollback()
		if rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			return errors.Join(fmt.Errorf("clear pending action flag: %w", err), fmt.Errorf("rollback action transaction: %w", rollbackErr))
		}
		return fmt.Errorf("clear pending action flag: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit action transaction: %w", err)
	}
	return nil
}

func checkIntegrity(ctx context.Context, writer *sql.DB) error {
	rows, err := writer.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("run foreign_key_check: %w", err)
	}
	if rows.Next() {
		var table string
		var rowID sql.NullInt64
		var parent string
		var foreignKeyID int
		if err := rows.Scan(&table, &rowID, &parent, &foreignKeyID); err != nil {
			return errors.Join(fmt.Errorf("read foreign_key_check result: %w", err), rows.Close())
		}
		violation := fmt.Errorf("foreign key violation in table %q row %v referencing %q (constraint %d)", table, rowID, parent, foreignKeyID)
		if err := rows.Close(); err != nil {
			return errors.Join(violation, fmt.Errorf("close foreign_key_check results: %w", err))
		}
		return violation
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read foreign_key_check results: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close foreign_key_check results: %w", err)
	}
	var result string
	if err := writer.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&result); err != nil {
		return fmt.Errorf("run quick_check: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("quick_check reported %q", result)
	}
	return nil
}

func databaseIsEmpty(ctx context.Context, writer *sql.DB) (bool, error) {
	var count int
	err := writer.QueryRowContext(ctx,
		"SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'goose_db_version'",
	).Scan(&count)
	return count == 0, err
}

func backupFailureContext(backupPath string, err error) error {
	if backupPath == "" {
		return err
	}
	return fmt.Errorf("%w (pre-migration backup: %s)", err, backupPath)
}

func newerDatabaseError(current, latest int64) error {
	return fmt.Errorf("database schema version %d is newer than this binary's latest version %d", current, latest)
}

func envBool(name string, fallback bool) (bool, error) {
	value, present := os.LookupEnv(name)
	if !present {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean: %w", name, err)
	}
	return parsed, nil
}

func validateMigrationVersions(files fs.FS, goMigrations []*goose.Migration) error {
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		return fmt.Errorf("list migration files: %w", err)
	}
	versions := make([]int64, 0, len(entries)+len(goMigrations))
	goFileVersions := make(map[int64]bool)
	for _, entry := range entries {
		match := migrationFilePattern.FindStringSubmatch(entry.Name())
		if match == nil {
			if strings.HasSuffix(entry.Name(), ".sql") {
				return fmt.Errorf("migration SQL file %q must have a 5-digit sequential version and name", entry.Name())
			}
			continue
		}
		var version int64
		if _, err := fmt.Sscanf(match[1], "%d", &version); err != nil {
			return fmt.Errorf("parse migration version from %q: %w", entry.Name(), err)
		}
		switch match[2] {
		case "sql":
			versions = append(versions, version)
		case "go":
			goFileVersions[version] = true
		}
	}
	registeredVersions := make(map[int64]bool, len(goMigrations))
	for _, migration := range goMigrations {
		if migration == nil {
			return errors.New("go migration registry contains nil")
		}
		if registeredVersions[migration.Version] {
			return fmt.Errorf("duplicate registered Go migration version %05d", migration.Version)
		}
		if goFileVersions[migration.Version] {
			delete(goFileVersions, migration.Version)
		}
		registeredVersions[migration.Version] = true
		versions = append(versions, migration.Version)
	}
	for version := range goFileVersions {
		return fmt.Errorf("go migration source %05d_*.go is not registered", version)
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	for i, version := range versions {
		expected := int64(i + 1)
		if version != expected {
			return fmt.Errorf("migration versions must be contiguous and sequential: expected %05d, found %05d", expected, version)
		}
	}
	if len(versions) == 0 {
		return errors.New("no migrations found")
	}
	return nil
}

func verifySum(files fs.FS) error {
	sumBytes, err := fs.ReadFile(files, "migrations.sum")
	if err != nil {
		return fmt.Errorf("read migrations.sum: %w", err)
	}
	expected := map[string]string{}
	for lineNumber, line := range strings.Split(strings.TrimSpace(string(sumBytes)), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || len(fields[0]) != 64 {
			return fmt.Errorf("invalid migrations.sum line %d", lineNumber+1)
		}
		if _, exists := expected[fields[1]]; exists {
			return fmt.Errorf("duplicate migrations.sum entry %q", fields[1])
		}
		expected[fields[1]] = fields[0]
	}
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		return fmt.Errorf("list migration files: %w", err)
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		if !migrationFilePattern.MatchString(entry.Name()) {
			if strings.HasSuffix(entry.Name(), ".sql") {
				return fmt.Errorf("migration SQL file %q is not listed in migrations.sum", entry.Name())
			}
			continue
		}
		data, err := fs.ReadFile(files, entry.Name())
		if err != nil {
			return fmt.Errorf("read migration %q: %w", entry.Name(), err)
		}
		hash := fmt.Sprintf("%x", sha256.Sum256(data))
		if expected[entry.Name()] != hash {
			return fmt.Errorf("migration checksum mismatch for %s", entry.Name())
		}
		seen[entry.Name()] = true
	}
	for name := range expected {
		if !seen[name] {
			if strings.HasSuffix(name, ".go") {
				continue
			}
			return fmt.Errorf("migrations.sum references missing migration %q", name)
		}
	}
	return nil
}
