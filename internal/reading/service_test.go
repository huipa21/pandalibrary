package reading

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

type readingFixture struct {
	service *Service
	db      *db.DB
}

func newReadingFixture(t *testing.T) readingFixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "reading.db")
	databases, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close databases: %v", err)
		}
	})
	runner, err := migrations.NewRunner(
		databases.Writer, path, migrations.Files(), migrations.Options{AutoMigrate: true},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(databases.Writer, databases.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return time.UnixMilli(2000).UTC() }
	statements := []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1),
			(2, 'reader', 'x', 'user', 1, 1),
			(3, 'other', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1), (20, 3, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(101, 10, 'Visible', 'visible', 1, 1),
			(102, 10, 'Hidden', 'hidden', 1, 1),
			(103, 20, 'Private', 'private', 1, 1)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 102, 1, 1)`,
		`INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
			VALUES (201, 101, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			        'epub', 1, 'book.epub', 1)`,
	}
	for _, statement := range statements {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed reading fixture: %v", err)
		}
	}
	return readingFixture{service: service, db: databases}
}

func mutation(entity, id, key, op, data string, updatedAt int64) Mutation {
	return Mutation{
		Entity: entity, ID: id, Key: key, Op: op, Data: json.RawMessage(data), UpdatedAt: &updatedAt,
	}
}

func TestReadingVisibilityOwnershipAndEmptyState(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	visible, err := fixture.service.GetBookState(ctx, Viewer{UserID: 2}, 101)
	if err != nil || visible.UserBook != nil || visible.Progress != nil ||
		visible.Highlights == nil || visible.Notes == nil {
		t.Fatalf("empty visible state = %+v, %v", visible, err)
	}
	for _, bookID := range []int64{102, 103, 999} {
		if _, err := fixture.service.GetBookState(ctx, Viewer{UserID: 2}, bookID); !errors.Is(err, ErrNotFound) {
			t.Errorf("GetBookState(%d) error = %v, want not found", bookID, err)
		}
	}
	response, err := fixture.service.Push(ctx, Viewer{UserID: 2}, PushRequest{Mutations: []Mutation{
		mutation("user_books", "", "103", "upsert",
			`{"status":"reading","book_id":103}`, 1000),
	}})
	if err != nil || response.Results[0].Status != "rejected" {
		t.Fatalf("write to inaccessible book = %+v, %v", response, err)
	}
}

func TestPushLWWClockClampPullAndAnnotationCascade(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	highlightID := "018f0f7e-7b00-7000-8000-000000000001"
	noteID := "018f0f7e-7b00-7000-8000-000000000002"
	push, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("user_books", "", "101", "upsert",
			`{"status":"reading","rating":8,"book_id":101}`, 9000),
		mutation("reading_progress", "", "101", "upsert",
			`{"book_id":101,"source":"web","locator":{"cfi":"a"},"percentage":0.4}`, 1200),
		mutation("highlights", highlightID, "", "upsert",
			`{"book_id":101,"locator":{"cfi":"b"},"position":0.4,"text":"alpha highlight","color":"yellow"}`, 1400),
		mutation("notes", noteID, "", "upsert",
			`{"book_id":101,"highlight_id":"018f0f7e-7b00-7000-8000-000000000001","body_md":"alpha note"}`, 1800),
	}})
	if err != nil {
		t.Fatal(err)
	}
	for i, result := range push.Results {
		if result.Status != "applied" {
			t.Fatalf("initial mutation %d = %+v", i, result)
		}
	}
	state, err := fixture.service.GetBookState(ctx, viewer, 101)
	if err != nil || state.UserBook == nil || state.Progress == nil ||
		state.UserBook.UpdatedAt.UnixMilli() != 2000 || state.Progress.UpdatedAt.UnixMilli() != 1200 ||
		len(state.Highlights) != 1 || len(state.Notes) != 1 {
		t.Fatalf("book state after push = %+v, %v", state, err)
	}
	tied, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("user_books", "", "101", "upsert", `{"status":"finished","book_id":101}`, 2000),
	}})
	if err != nil || tied.Results[0].Status != "stale" {
		t.Fatalf("timestamp tie = %+v, %v", tied, err)
	}
	future, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("reading_progress", "", "101", "upsert",
			`{"book_id":101,"source":"web","percentage":0.8}`, 9000),
	}})
	if err != nil || future.Results[0].Status != "applied" {
		t.Fatalf("future timestamp mutation = %+v, %v", future, err)
	}
	state, err = fixture.service.GetBookState(ctx, viewer, 101)
	if err != nil || state.Progress == nil || state.Progress.UpdatedAt.UnixMilli() != 2000 ||
		state.Progress.Percentage != 0.8 {
		t.Fatalf("clamped progress = %+v, %v", state.Progress, err)
	}
	duplicateSessionID := "018f0f7e-7b00-7000-8000-000000000003"
	session := mutation("reading_sessions", duplicateSessionID, "", "upsert",
		`{"book_id":101,"source":"web","started_at":1900,"ended_at":3000,"active_seconds":90}`, 1500)
	first, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{session}})
	if err != nil || first.Results[0].Status != "applied" {
		t.Fatalf("session insert = %+v, %v", first, err)
	}
	second, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{session}})
	if err != nil || second.Results[0].Status != "stale" {
		t.Fatalf("session duplicate = %+v, %v", second, err)
	}
	var sessionStart, sessionEnd int64
	if err := fixture.db.Reader.QueryRowContext(ctx,
		`SELECT started_at, ended_at FROM reading_sessions WHERE id = ?`, duplicateSessionID,
	).Scan(&sessionStart, &sessionEnd); err != nil || sessionStart != 1900 || sessionEnd != 2000 {
		t.Fatalf("clamped session times = (%d, %d), %v", sessionStart, sessionEnd, err)
	}
	search, err := fixture.service.SearchAnnotations(ctx, viewer, "alpha", "")
	if err != nil || len(search) != 2 {
		t.Fatalf("annotation FTS results = %+v, %v", search, err)
	}
	cursor, err := fixture.service.Pull(ctx, viewer, 0)
	if err != nil || cursor.Cursor == 0 || len(cursor.UserBooks) != 1 ||
		len(cursor.Progress) != 1 || len(cursor.Highlights) != 1 || len(cursor.Notes) != 1 ||
		cursor.UserBooks[0].UpdatedAt.UnixMilli() != 2000 {
		t.Fatalf("pull snapshot = %+v, %v", cursor, err)
	}
	deleteResult, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("highlights", highlightID, "", "delete", `{}`, 1600),
	}})
	if err != nil || deleteResult.Results[0].Status != "applied" {
		t.Fatalf("highlight deletion = %+v, %v", deleteResult, err)
	}
	state, err = fixture.service.GetBookState(ctx, viewer, 101)
	if err != nil || len(state.Highlights) != 0 || len(state.Notes) != 0 {
		t.Fatalf("state after highlight cascade = %+v, %v", state, err)
	}
	search, err = fixture.service.SearchAnnotations(ctx, viewer, "alpha", "")
	if err != nil || len(search) != 0 {
		t.Fatalf("search after tombstone = %+v, %v", search, err)
	}
	oldNoteEdit, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("notes", noteID, "", "upsert",
			`{"book_id":101,"body_md":"an older note edit"}`, 1700),
	}})
	if err != nil || oldNoteEdit.Results[0].Status != "stale" {
		t.Fatalf("older edit after highlight cascade = %+v, %v", oldNoteEdit, err)
	}
	after, err := fixture.service.Pull(ctx, viewer, cursor.Cursor)
	if err != nil || len(after.Highlights) != 1 || after.Highlights[0].DeletedAt == nil ||
		len(after.Notes) != 1 || after.Notes[0].DeletedAt == nil {
		t.Fatalf("pull tombstones = %+v, %v", after, err)
	}
}

func TestPushRejectsForeignRowsAndFiltersSyncVisibility(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	highlightIDs := []struct {
		id     string
		userID int64
		bookID int64
		text   string
	}{
		{"018f0f7e-7b00-7000-8000-000000000004", 3, 101, "alpha foreign user"},
		{"018f0f7e-7b00-7000-8000-000000000005", 2, 102, "alpha hidden book"},
		{"018f0f7e-7b00-7000-8000-000000000006", 2, 103, "alpha inaccessible book"},
		{"018f0f7e-7b00-7000-8000-000000000007", 2, 101, "alpha visible"},
		{"018f0f7e-7b00-7000-8000-00000000000c", 2, 101, "100% literal"},
	}
	for _, row := range highlightIDs {
		if _, err := fixture.db.Writer.ExecContext(ctx, `
			INSERT INTO highlights (id, user_id, book_id, locator, position, text, color, created_at, updated_at, rev)
			VALUES (?, ?, ?, '{"page":1}', 0.2, ?, 'yellow', 10, 10, 1)
		`, row.id, row.userID, row.bookID, row.text); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.db.Writer.ExecContext(ctx, `
			INSERT INTO highlights_fts (rowid, text, user_id, book_id)
			SELECT seq, text, user_id, book_id FROM highlights WHERE id = ?
		`, row.id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO notes (id, user_id, book_id, body_md, created_at, updated_at, rev)
		VALUES ('018f0f7e-7b00-7000-8000-000000000008', 2, 101, 'alpha visible note', 10, 10, 1),
		       ('018f0f7e-7b00-7000-8000-000000000009', 2, 102, 'alpha hidden note', 10, 10, 1),
		       ('018f0f7e-7b00-7000-8000-00000000000b', 3, 101, 'alpha foreign user note', 10, 10, 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO notes_fts (rowid, body, highlight_text, user_id, book_id)
		SELECT seq, body_md, '', user_id, book_id FROM notes
	`); err != nil {
		t.Fatal(err)
	}
	result, err := fixture.service.Push(ctx, Viewer{UserID: 2}, PushRequest{Mutations: []Mutation{
		mutation("highlights", highlightIDs[0].id, "", "delete", `{}`, 100),
		mutation("notes", "018f0f7e-7b00-7000-8000-00000000000b", "", "delete", `{}`, 100),
		mutation("notes", "018f0f7e-7b00-7000-8000-00000000000a", "", "upsert",
			`{"book_id":103,"body_md":"private"}`, 100),
		mutation("user_books", "", "102", "upsert",
			`{"status":"reading","book_id":102}`, 100),
	}})
	if err != nil || result.Results[0].Status != "rejected" ||
		result.Results[1].Status != "rejected" || result.Results[2].Status != "rejected" ||
		result.Results[3].Status != "rejected" {
		t.Fatalf("rejected hidden/foreign writes = %+v, %v", result, err)
	}
	adminRows, err := fixture.service.Push(ctx, Viewer{UserID: 1, IsAdmin: true}, PushRequest{Mutations: []Mutation{
		mutation("user_books", "", "102", "upsert", `{"status":"reading","book_id":102}`, 100),
	}})
	if err != nil || adminRows.Results[0].Status != "applied" {
		t.Fatalf("admin write to visible book = %+v, %v", adminRows, err)
	}
	userPull, err := fixture.service.Pull(ctx, Viewer{UserID: 2}, 0)
	if err != nil || len(userPull.UserBooks) != 0 {
		t.Fatalf("user pull exposed hidden book = %+v, %v", userPull, err)
	}
	for _, test := range []struct {
		query string
		count int
	}{{"alpha", 2}, {"al", 3}} {
		results, err := fixture.service.SearchAnnotations(ctx, Viewer{UserID: 2}, test.query, "")
		if err != nil || len(results) != test.count {
			t.Fatalf("visible-only search %q = %+v, %v", test.query, results, err)
		}
		for _, row := range results {
			if row.BookID != 101 || row.Kind == "" {
				t.Errorf("search %q exposed an annotation: %+v", test.query, row)
			}
		}
		wildcardResults, err := fixture.service.SearchAnnotations(ctx, Viewer{UserID: 2}, "%", "")
		if err != nil || len(wildcardResults) != 1 || wildcardResults[0].Content != "100% literal" {
			t.Fatalf("escaped LIKE wildcard search = %+v, %v", wildcardResults, err)
		}
	}
	adminPull, err := fixture.service.Pull(ctx, Viewer{UserID: 1, IsAdmin: true}, 0)
	if err != nil || len(adminPull.UserBooks) != 1 || adminPull.UserBooks[0].BookID != 102 {
		t.Fatalf("admin pull hidden-by-other-user book = %+v, %v", adminPull, err)
	}
}

func TestPushBatchRollsBackOnDatabaseFailure(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		CREATE TRIGGER fail_setting BEFORE INSERT ON user_settings
		WHEN NEW.key = 'fail' BEGIN SELECT RAISE(ABORT, 'forced failure'); END
	`); err != nil {
		t.Fatal(err)
	}
	_, err := fixture.service.Push(ctx, Viewer{UserID: 2}, PushRequest{Mutations: []Mutation{
		mutation("user_settings", "", "first", "upsert", `{"value":{"ok":true}}`, 100),
		mutation("user_settings", "", "fail", "upsert", `{"value":{"ok":false}}`, 100),
	}})
	if err == nil {
		t.Fatal("push with a database failure succeeded")
	}
	var count, revision int64
	if err := fixture.db.Reader.QueryRowContext(ctx,
		`SELECT count(*) FROM user_settings WHERE user_id = 2`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.Reader.QueryRowContext(ctx,
		`SELECT value FROM sync_counter WHERE id = 1`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if count != 0 || revision != 0 {
		t.Fatalf("failed batch left rows=%d revision=%d", count, revision)
	}
}

func TestSettingsAndCursorValidation(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	set, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("user_settings", "", "reader.epub", "upsert", `{"value":{"font_size":18}}`, 100),
	}})
	if err != nil || set.Results[0].Status != "applied" {
		t.Fatalf("setting push = %+v, %v", set, err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO user_settings (user_id, key, value, updated_at, rev)
		VALUES (3, 'private', '{"user":3}', 100, 1)
	`); err != nil {
		t.Fatal(err)
	}
	settings, err := fixture.service.ListSettings(ctx, viewer)
	if err != nil || len(settings) != 1 || settings[0].Key != "reader.epub" ||
		string(settings[0].Value) != `{"font_size":18}` {
		t.Fatalf("settings list = %+v, %v", settings, err)
	}
	if _, err := fixture.service.Pull(ctx, viewer, -1); !errors.Is(err, ErrInvalid) {
		t.Fatalf("negative cursor error = %v", err)
	}
	if _, err := fixture.service.Pull(ctx, viewer, 2); !errors.Is(err, ErrInvalid) {
		t.Fatalf("cursor ahead of server error = %v", err)
	}
	if _, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: make([]Mutation, maxPushMutations+1)}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("oversized push error = %v", err)
	}
}

func TestIdenticalSettingReplayAcknowledgesWithoutNewRevision(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	key := "reader.book.101"
	value := `{"value":{"pdfLayout":"single","theme":"light"}}`
	original := mutation("user_settings", "", key, "upsert", value, 1000)
	push := func(item Mutation, want string) {
		t.Helper()
		result, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{item}})
		if err != nil || len(result.Results) != 1 || result.Results[0].Status != want {
			t.Fatalf("setting push = %+v, %v; want %s", result, err, want)
		}
	}

	push(original, "applied")
	before, err := fixture.service.Pull(ctx, viewer, 0)
	if err != nil {
		t.Fatal(err)
	}
	push(original, "applied")
	push(mutation("user_settings", "", key, "upsert", `{"value":{"pdfLayout":"split"}}`, 1000), "stale")
	push(mutation("user_settings", "", key, "upsert", `{"value":{"theme":"light","pdfLayout":"single"}}`, 1000), "stale")
	push(mutation("user_settings", "", key, "upsert", value, 999), "stale")
	after, err := fixture.service.Pull(ctx, viewer, before.Cursor)
	if err != nil || after.Cursor != before.Cursor || len(after.Settings) != 0 {
		t.Fatalf("replayed setting advanced the cursor: before=%d after=%+v err=%v", before.Cursor, after, err)
	}
	settings, err := fixture.service.ListSettings(ctx, viewer)
	if err != nil || len(settings) != 1 || string(settings[0].Value) != `{"pdfLayout":"single","theme":"light"}` {
		t.Fatalf("setting after replay = %+v, %v", settings, err)
	}
	push(mutation("user_settings", "", key, "upsert", `{"value":{"pdfLayout":"split"}}`, 1001), "applied")

	other := Viewer{UserID: 3}
	for i := 0; i < 2; i++ {
		result, err := fixture.service.Push(ctx, other, PushRequest{Mutations: []Mutation{original}})
		if err != nil || len(result.Results) != 1 || result.Results[0].Status != "applied" {
			t.Fatalf("other user's setting push %d = %+v, %v", i, result, err)
		}
	}
	otherSettings, err := fixture.service.ListSettings(ctx, other)
	if err != nil || len(otherSettings) != 1 || string(otherSettings[0].Value) != `{"pdfLayout":"single","theme":"light"}` {
		t.Fatalf("other user's setting = %+v, %v", otherSettings, err)
	}
}
