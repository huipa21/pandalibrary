package migrations

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"

	"pandalibrary/internal/db"
)

func TestMigrationsSum(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file path")
	}
	files := os.DirFS(filepath.Dir(currentFile))
	if err := verifySum(files); err != nil {
		t.Fatal(err)
	}
	if err := validateMigrationVersions(files, GoMigrations); err != nil {
		t.Fatal(err)
	}
}

func TestMigrationSumAndVersionValidation(t *testing.T) {
	initial, err := fs.ReadFile(embedded, "00001_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	changed := append(append([]byte(nil), initial...), []byte("\n-- modified\n")...)
	badSum := fmt.Sprintf("%x  00001_init.sql\n", sha256.Sum256(initial))
	if err := verifySum(fstest.MapFS{
		"00001_init.sql": {Data: changed},
		"migrations.sum": {Data: []byte(badSum)},
	}); err == nil {
		t.Fatal("verifySum() accepted a modified migration")
	}
	gappedFiles := fstest.MapFS{
		"00001_one.sql":   {Data: []byte("-- +goose Up\nSELECT 1;\n-- +goose Down\nSELECT 1;\n")},
		"00003_three.sql": {Data: []byte("-- +goose Up\nSELECT 1;\n-- +goose Down\nSELECT 1;\n")},
	}
	if err := validateMigrationVersions(gappedFiles, nil); err == nil {
		t.Fatal("validateMigrationVersions() accepted a version gap")
	}
}

func TestMigrationCreationAndSumGeneration(t *testing.T) {
	dir := t.TempDir()
	initial := []byte("-- +goose Up\nSELECT 1;\n-- +goose Down\nSELECT 1;\n")
	if err := os.WriteFile(filepath.Join(dir, "00001_initial.sql"), initial, 0o644); err != nil {
		t.Fatal(err)
	}
	path, err := CreateSQLMigration(dir, "add_example")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "00002_add_example.sql" {
		t.Fatalf("created migration = %q, want 00002_add_example.sql", filepath.Base(path))
	}
	if err := GenerateSum(dir); err != nil {
		t.Fatal(err)
	}
	if err := verifySum(os.DirFS(dir)); err != nil {
		t.Fatal(err)
	}
	if err := validateMigrationVersions(os.DirFS(dir), nil); err != nil {
		t.Fatal(err)
	}
}

func TestUpFromEmpty(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	runner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	current, latest, err := runner.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if current != embeddedLatest || latest != embeddedLatest {
		t.Fatalf("versions = (%d, %d), want (%d, %d)", current, latest, embeddedLatest, embeddedLatest)
	}
	var value int64
	if err := databases.Writer.QueryRowContext(ctx, "SELECT value FROM sync_counter WHERE id = 1").Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != 0 {
		t.Fatalf("initial sync revision = %d, want 0", value)
	}
}

func TestUpDownUp(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	runner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if err := runner.DownTo(ctx, 0); err != nil {
		t.Fatal(err)
	}
	current, _, err := runner.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if current != 0 {
		t.Fatalf("version after DownTo(0) = %d, want 0", current)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	current, _, err = runner.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if current != embeddedLatest {
		t.Fatalf("version after re-up = %d, want %d", current, embeddedLatest)
	}
}

func TestShelfModesMigrationPreservesDataAndProvisionsFavorites(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	v1 := newTestRunner(t, databases.Writer, databasePath, embeddedPrefixFS(t, 1), DefaultOptions())
	if err := v1.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1), (2, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (10, 'Main', 'main', 1, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(101, 10, 'A', 'a', 1, 1), (102, 10, 'B', 'b', 1, 1)`,
		`INSERT INTO shelves (id, kind, owner_id, name, description, created_by, created_at, updated_at) VALUES
			(5, 'private', 2, 'Favorites', 'custom', 2, 7, 7),
			(6, 'shared', NULL, 'Staff', NULL, 1, 8, 8)`,
		`INSERT INTO shelf_books (shelf_id, book_id, position, added_by, added_at) VALUES
			(5, 102, 0, 2, 9), (5, 101, 1, 2, 10)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}

	runner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	assertState := func(label string) {
		t.Helper()
		var name, description, mode string
		var systemKey sql.NullString
		if err := databases.Writer.QueryRowContext(ctx,
			"SELECT name, description, mode, system_key FROM shelves WHERE id = 5",
		).Scan(&name, &description, &mode, &systemKey); err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		if name != "Favorites" || description != "custom" || mode != "manual" || systemKey.Valid {
			t.Fatalf("%s: custom shelf = (%q, %q, %q, %v), want preserved manual non-system shelf", label, name, description, mode, systemKey)
		}
		rows, err := databases.Writer.QueryContext(ctx, "SELECT book_id FROM shelf_books WHERE shelf_id = 5 ORDER BY position")
		if err != nil {
			t.Fatal(err)
		}
		var order []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			order = append(order, id)
		}
		_ = rows.Close()
		if fmt.Sprint(order) != "[102 101]" {
			t.Fatalf("%s: custom shelf order = %v, want [102 101]", label, order)
		}
		for _, userID := range []int64{1, 2} {
			var count int
			if err := databases.Writer.QueryRowContext(ctx,
				"SELECT count(*) FROM shelves WHERE owner_id = ? AND system_key = 'favorites' AND kind = 'private' AND mode = 'manual' AND rules IS NULL",
				userID,
			).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 1 {
				t.Fatalf("%s: user %d favorites count = %d, want 1", label, userID, count)
			}
		}
		var sharedMode string
		if err := databases.Writer.QueryRowContext(ctx, "SELECT mode FROM shelves WHERE id = 6").Scan(&sharedMode); err != nil {
			t.Fatal(err)
		}
		if sharedMode != "manual" {
			t.Fatalf("%s: shared shelf mode = %q, want manual", label, sharedMode)
		}
	}
	assertState("after upgrade")

	if _, err := databases.Writer.ExecContext(ctx,
		"INSERT INTO shelves (kind, owner_id, name, mode, system_key, created_at, updated_at) VALUES ('private', 2, 'Favorites', 'manual', 'favorites', 1, 1)",
	); err == nil {
		t.Fatal("second favorites shelf for the same user was accepted")
	}
	if _, err := databases.Writer.ExecContext(ctx,
		"INSERT INTO shelves (kind, owner_id, name, mode, rules, created_at, updated_at) VALUES ('shared', NULL, 'Auto', 'automatic', '{}', 1, 1)",
	); err == nil {
		t.Fatal("shared automatic shelf was accepted")
	}
	if _, err := databases.Writer.ExecContext(ctx,
		"INSERT INTO shelves (kind, owner_id, name, mode, created_at, updated_at) VALUES ('private', 2, 'Auto', 'automatic', 1, 1)",
	); err == nil {
		t.Fatal("automatic shelf without rules was accepted")
	}

	if err := runner.DownTo(ctx, 1); err != nil {
		t.Fatal(err)
	}
	var shelves int
	if err := databases.Writer.QueryRowContext(ctx, "SELECT count(*) FROM shelves").Scan(&shelves); err != nil {
		t.Fatal(err)
	}
	if shelves != 2 {
		t.Fatalf("shelves after down = %d, want the 2 original shelves", shelves)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	assertState("after re-up")
}
func TestUpgradeCreatesBackup(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	initialRunner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := initialRunner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	fakeFiles := migrationFS(t, "CREATE TABLE fake_migration (id INTEGER PRIMARY KEY);", "DROP TABLE fake_migration;")
	options := DefaultOptions()
	runner := newTestRunner(t, databases.Writer, databasePath, fakeFiles, options)
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := databases.Writer.QueryRowContext(ctx,
		"SELECT count(*) FROM sqlite_master WHERE type='table' AND name='fake_migration'",
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("fake migration was not applied")
	}
	backups, err := filepath.Glob(filepath.Join(filepath.Dir(databasePath), "backups", fmt.Sprintf("pre-migrate-v%d-v%d-*.db", embeddedLatest, embeddedLatest+1)))
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 1 {
		t.Fatalf("backup files = %v, want one pre-migration backup", backups)
	}
	backupDB, err := sql.Open("sqlite", backups[0])
	if err != nil {
		t.Fatal(err)
	}
	defer backupDB.Close()
	var backupVersion int64
	if err := backupDB.QueryRowContext(ctx,
		"SELECT max(version_id) FROM goose_db_version WHERE is_applied = 1",
	).Scan(&backupVersion); err != nil {
		t.Fatal(err)
	}
	if backupVersion != embeddedLatest {
		t.Fatalf("backup version = %d, want pre-upgrade version %d", backupVersion, embeddedLatest)
	}
}

func TestUpgradeFailureReportsBackupPath(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	initialRunner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := initialRunner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	options := DefaultOptions()
	options.BackupDir = filepath.Join(t.TempDir(), "backups")
	runner := newTestRunner(t, databases.Writer, databasePath,
		migrationFS(t, "INSERT INTO missing_table (id) VALUES (1);", "SELECT 1;"),
		options)
	err := runner.Up(ctx)
	if err == nil || !strings.Contains(err.Error(), options.BackupDir) {
		t.Fatalf("Up() error = %v, want backup path %q", err, options.BackupDir)
	}
}

func TestRefuseNewerDB(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	runner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx,
		"INSERT INTO goose_db_version (version_id, is_applied, tstamp) VALUES (99, 1, CURRENT_TIMESTAMP)",
	); err != nil {
		t.Fatal(err)
	}
	err := runner.Run(ctx)
	if err == nil || !strings.Contains(err.Error(), "newer than this binary") {
		t.Fatalf("Run() error = %v, want newer-database error", err)
	}
}

func TestAutoMigrationDisabled(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	initialRunner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := initialRunner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	options := DefaultOptions()
	options.AutoMigrate = false
	runner := newTestRunner(t, databases.Writer, databasePath,
		migrationFS(t, "CREATE TABLE fake_migration (id INTEGER PRIMARY KEY);", "DROP TABLE fake_migration;"),
		options)
	err := runner.Run(ctx)
	if err == nil || !strings.Contains(err.Error(), "run 'pandalibrary migrate up'") {
		t.Fatalf("Run() error = %v, want manual-up instruction", err)
	}
	current, _, err := runner.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if current != embeddedLatest {
		t.Fatalf("database version = %d, want %d when auto-migrate is disabled", current, embeddedLatest)
	}
}

func TestBackupDisabled(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	initialRunner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := initialRunner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	options := DefaultOptions()
	options.Backup = false
	runner := newTestRunner(t, databases.Writer, databasePath,
		migrationFS(t, "CREATE TABLE fake_migration (id INTEGER PRIMARY KEY);", "DROP TABLE fake_migration;"),
		options)
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	backups, err := filepath.Glob(filepath.Join(filepath.Dir(databasePath), "backups", "*.db"))
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 0 {
		t.Fatalf("backup files = %v, want none", backups)
	}
}

func TestMigrationActionRetainsFlagOnFailure(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	runner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx,
		"INSERT INTO server_settings (key, value, updated_at) VALUES ('migrate.pending.test', 'true', 1)",
	); err != nil {
		t.Fatal(err)
	}
	options := DefaultOptions()
	options.Actions = []PostMigrationAction{{
		Key: "migrate.pending.test",
		Run: func(context.Context, *sql.Tx) error { return fmt.Errorf("simulated failure") },
	}}
	runner = newTestRunner(t, databases.Writer, databasePath, embedded, options)
	if err := runner.Run(ctx); err == nil {
		t.Fatal("Run() unexpectedly succeeded")
	}
	var count int
	if err := databases.Writer.QueryRowContext(ctx,
		"SELECT count(*) FROM server_settings WHERE key = 'migrate.pending.test'",
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("pending flag count = %d, want 1", count)
	}
}

func TestMigrationActionClearsFlagAfterSuccess(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	runner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx,
		"INSERT INTO server_settings (key, value, updated_at) VALUES ('migrate.pending.test', 'true', 1)",
	); err != nil {
		t.Fatal(err)
	}
	options := DefaultOptions()
	var actionRan bool
	options.Actions = []PostMigrationAction{{
		Key: "migrate.pending.test",
		Run: func(context.Context, *sql.Tx) error {
			actionRan = true
			return nil
		},
	}}
	runner = newTestRunner(t, databases.Writer, databasePath, embedded, options)
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if !actionRan {
		t.Fatal("registered post-migration action did not run")
	}
	var count int
	if err := databases.Writer.QueryRowContext(ctx,
		"SELECT count(*) FROM server_settings WHERE key = 'migrate.pending.test'",
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("pending flag count = %d, want 0 after successful action", count)
	}
}

func TestDefaultOptionsReadMigrationEnvironment(t *testing.T) {
	t.Setenv("PANDA_AUTO_MIGRATE", "false")
	t.Setenv("PANDA_MIGRATE_BACKUP", "false")
	databases, databasePath := openTestDB(t)
	runner, err := NewRunner(databases.Writer, databasePath, embedded, DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if runner.options.AutoMigrate {
		t.Fatal("PANDA_AUTO_MIGRATE=false was ignored")
	}
	if runner.options.Backup {
		t.Fatal("PANDA_MIGRATE_BACKUP=false was ignored")
	}
}

func openTestDB(t *testing.T) (*db.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "library.db")
	databases, err := db.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close test database: %v", err)
		}
	})
	return databases, path
}

func newTestRunner(t *testing.T, writer *sql.DB, path string, files fs.FS, options Options) *Runner {
	t.Helper()
	options.ReadEnvironment = false
	runner, err := NewRunner(writer, path, files, options)
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

const embeddedLatest = 3

// embeddedPrefixFS returns the embedded migrations up to and including version max, with a matching sum.
func embeddedPrefixFS(t *testing.T, max int) fstest.MapFS {
	t.Helper()
	entries, err := fs.ReadDir(embedded, ".")
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{}
	var sum strings.Builder
	for _, entry := range entries {
		match := migrationFilePattern.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		var version int
		if _, err := fmt.Sscanf(match[1], "%d", &version); err != nil {
			t.Fatal(err)
		}
		if version > max {
			continue
		}
		data, err := fs.ReadFile(embedded, entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		files[entry.Name()] = &fstest.MapFile{Data: data}
		fmt.Fprintf(&sum, "%x  %s\n", sha256.Sum256(data), entry.Name())
	}
	files["migrations.sum"] = &fstest.MapFile{Data: []byte(sum.String())}
	return files
}

func migrationFS(t *testing.T, up, down string) fs.FS {
	t.Helper()
	files := embeddedPrefixFS(t, embeddedLatest)
	name := fmt.Sprintf("%05d_fake.sql", embeddedLatest+1)
	fake := []byte(fmt.Sprintf("-- +goose Up\n\n%s\n\n-- +goose Down\n\n%s\n", up, down))
	files[name] = &fstest.MapFile{Data: fake}
	sum := string(files["migrations.sum"].Data) + fmt.Sprintf("%x  %s\n", sha256.Sum256(fake), name)
	files["migrations.sum"] = &fstest.MapFile{Data: []byte(sum)}
	return files
}