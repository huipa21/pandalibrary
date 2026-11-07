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
func TestBookheapMigrationPreservesImportJobs(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	v3 := newTestRunner(t, databases.Writer, databasePath, embeddedPrefixFS(t, 3), DefaultOptions())
	if err := v3.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (1, 'admin', 'x', 'admin', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (10, 'Main', 'main', 1, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (101, 10, 'A', 'a', 1, 1)`,
		`INSERT INTO import_jobs (id, source, library_id, user_id, original_name, sha256, status, error, book_id, created_at, finished_at)
			VALUES (1, 'upload', 10, 1, 'a.epub', NULL, 'imported', NULL, 101, 5, 6),
			(2, 'drop_folder', 10, NULL, 'b.epub', NULL, 'failed', 'bad', NULL, 7, 8)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	jobs := func() string {
		t.Helper()
		rows, err := databases.Writer.QueryContext(ctx, `SELECT id, source, original_name, status, coalesce(error, ''), coalesce(book_id, 0), created_at FROM import_jobs ORDER BY id`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var result []string
		for rows.Next() {
			var id, bookID, created int64
			var source, name, status, message string
			if err := rows.Scan(&id, &source, &name, &status, &message, &bookID, &created); err != nil {
				t.Fatal(err)
			}
			result = append(result, fmt.Sprintf("%d|%s|%s|%s|%s|%d|%d", id, source, name, status, message, bookID, created))
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return strings.Join(result, ";")
	}
	before := jobs()
	runner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if got := jobs(); got != before {
		t.Fatalf("jobs after up = %s, want %s", got, before)
	}
	if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO import_jobs (id, source, library_id, original_name, status, created_at)
		VALUES (3, 'bookheap', 10, 'c.epub', 'pending', 9)`); err != nil {
		t.Fatalf("bookheap import source rejected: %v", err)
	}
	if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO bookheap_items
		(rel_path, file_name, size_bytes, mtime_ns, title, source, status, import_job_id, created_at, updated_at)
		VALUES ('c.epub', 'c.epub', 1, 1, 'C', 'scan', 'queued', 3, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO bookheap_items (rel_path, file_name, size_bytes, mtime_ns, title, source, created_at, updated_at) VALUES ('c.epub', 'c', 1, 1, 'C', 'scan', 1, 1)`,
		`INSERT INTO bookheap_items (rel_path, file_name, size_bytes, mtime_ns, title, source, authors, created_at, updated_at) VALUES ('d.epub', 'd', 1, 1, 'D', 'scan', '{}', 1, 1)`,
		`INSERT INTO bookheap_items (rel_path, file_name, size_bytes, mtime_ns, title, source, status, created_at, updated_at) VALUES ('e.epub', 'e', 1, 1, 'E', 'scan', 'gone', 1, 1)`,
		`INSERT INTO import_jobs (source, library_id, original_name, created_at) VALUES ('other', 10, 'x', 1)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err == nil {
			t.Fatalf("constraint not enforced: %s", statement)
		}
	}
	if err := runner.DownTo(ctx, 3); err != nil {
		t.Fatal(err)
	}
	if got, want := jobs(), before+";3|upload|c.epub|pending||0|9"; got != want {
		t.Fatalf("jobs after down = %s, want %s", got, want)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var indexes int
	if err := databases.Writer.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'import_jobs' AND name IN ('import_jobs_status_created', 'import_jobs_created')`).Scan(&indexes); err != nil || indexes != 2 {
		t.Fatalf("import job indexes = %d, %v", indexes, err)
	}
	if got, want := jobs(), before+";3|upload|c.epub|pending||0|9"; got != want {
		t.Fatalf("jobs after re-up = %s, want %s", got, want)
	}
}

func TestReadingStatusesMigrationPreservesRowsAndMapsRollback(t *testing.T) {
	ctx := context.Background()
	databases, databasePath := openTestDB(t)
	v4 := newTestRunner(t, databases.Writer, databasePath, embeddedPrefixFS(t, 4), DefaultOptions())
	if err := v4.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (1, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES (10, 'Main', 'main', 1, 1)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	for id := int64(101); id <= 109; id++ {
		if _, err := databases.Writer.ExecContext(ctx,
			`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES (?, 10, 'A', 'a', 1, 1)`, id,
		); err != nil {
			t.Fatal(err)
		}
	}
	insert := func(id int64, status string) {
		t.Helper()
		if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO user_books
			(user_id, book_id, status, rating, started_at, finished_at, updated_at, rev)
			VALUES (1, ?, ?, 7, 12, 34, 56, ?)`, id, status, id-100); err != nil {
			t.Fatalf("insert %s: %v", status, err)
		}
	}
	old := []string{"unread", "want_to_read", "reading", "finished", "abandoned"}
	for i, status := range old {
		insert(int64(101+i), status)
	}
	if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO user_books (user_id, book_id, updated_at, rev)
		VALUES (1, 109, 57, 9)`); err != nil {
		t.Fatal(err)
	}

	assertState := func(stage string, statuses []string) {
		t.Helper()
		for i, want := range statuses {
			var status string
			var rating, started, finished, updated, rev int64
			err := databases.Writer.QueryRowContext(ctx, `SELECT status, rating, started_at, finished_at, updated_at, rev
				FROM user_books WHERE user_id = 1 AND book_id = ?`, 101+i).
				Scan(&status, &rating, &started, &finished, &updated, &rev)
			if err != nil || status != want || rating != 7 || started != 12 || finished != 34 || updated != 56 || rev != int64(i+1) {
				t.Fatalf("%s row %d = %q,%d,%d,%d,%d,%d, %v", stage, 101+i, status, rating, started, finished, updated, rev, err)
			}
		}
		var count, indexes, violations int
		var defaultStatus string
		var rating, started, finished sql.NullInt64
		var updated, rev int64
		err := databases.Writer.QueryRowContext(ctx, `SELECT status, rating, started_at, finished_at, updated_at, rev
			FROM user_books WHERE user_id = 1 AND book_id = 109`).
			Scan(&defaultStatus, &rating, &started, &finished, &updated, &rev)
		if err != nil || defaultStatus != "unread" || rating.Valid || started.Valid || finished.Valid || updated != 57 || rev != 9 {
			t.Fatalf("%s nullable row = %q,%v,%v,%v,%d,%d, %v", stage, defaultStatus, rating, started, finished, updated, rev, err)
		}
		if err := databases.Writer.QueryRowContext(ctx, `SELECT count(*) FROM user_books`).Scan(&count); err != nil || count != len(statuses)+1 {
			t.Fatalf("%s row count = %d, %v", stage, count, err)
		}
		if err := databases.Writer.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master
			WHERE type = 'index' AND tbl_name = 'user_books'
			AND name IN ('user_books_user_rev', 'user_books_user_status')`).Scan(&indexes); err != nil || indexes != 2 {
			t.Fatalf("%s indexes = %d, %v", stage, indexes, err)
		}
		if err := databases.Writer.QueryRowContext(ctx, `SELECT count(*) FROM pragma_foreign_key_check`).Scan(&violations); err != nil || violations != 0 {
			t.Fatalf("%s foreign key violations = %d, %v", stage, violations, err)
		}
		var schema string
		if err := databases.Writer.QueryRowContext(ctx, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_books'`).Scan(&schema); err != nil || !strings.Contains(schema, "WITHOUT ROWID") {
			t.Fatalf("%s table schema = %q, %v", stage, schema, err)
		}
	}

	runner := newTestRunner(t, databases.Writer, databasePath, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	assertState("after up", old)
	for i, status := range []string{"on_hold", "rereading", "skimmed"} {
		insert(int64(106+i), status)
	}
	assertState("new statuses", append(append([]string(nil), old...), "on_hold", "rereading", "skimmed"))
	if _, err := databases.Writer.ExecContext(ctx, `UPDATE user_books SET status = 'invalid' WHERE book_id = 101`); err == nil {
		t.Fatal("invalid reading status was accepted")
	}
	if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO user_books (user_id, book_id, updated_at, rev) VALUES (1, 999, 1, 1)`); err == nil {
		t.Fatal("user_books foreign key was not enforced")
	}

	if err := runner.DownTo(ctx, 4); err != nil {
		t.Fatal(err)
	}
	rolledBack := append(append([]string(nil), old...), "reading", "reading", "finished")
	assertState("after down", rolledBack)
	for _, status := range []string{"on_hold", "rereading", "skimmed"} {
		if _, err := databases.Writer.ExecContext(ctx, `UPDATE user_books SET status = ? WHERE book_id = 101`, status); err == nil {
			t.Fatalf("rollback accepted %s", status)
		}
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	assertState("after re-up", rolledBack)
	if _, err := databases.Writer.ExecContext(ctx, `DELETE FROM books WHERE id = 101`); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := databases.Writer.QueryRowContext(ctx, `SELECT count(*) FROM user_books WHERE book_id = 101`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("book deletion did not cascade: count = %d, %v", remaining, err)
	}
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

const embeddedLatest = 5

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
