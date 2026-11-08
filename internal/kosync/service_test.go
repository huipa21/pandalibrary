package kosync

import (
	"context"
	"crypto/md5"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
	"pandalibrary/internal/reading"
)

type fixture struct {
	db      *db.DB
	service *Service
	reading *reading.Service
	now     time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kosync.db")
	database, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Error(err)
		}
	})
	runner, err := migrations.NewRunner(database.Writer, path, migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	state, err := reading.NewService(database.Writer, database.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(database.Writer, database.Reader, state, Options{})
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{db: database, service: service, reading: state, now: time.UnixMilli(1700000000123)}
	service.now = func() time.Time { return f.now }
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1), (2, 'reader', 'x', 'user', 1, 1),
			(3, 'other', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(101, 10, 'Visible', 'visible', 1, 1), (102, 10, 'Hidden', 'hidden', 1, 1),
			(103, 20, 'Private', 'private', 1, 1), (104, 10, 'PDF', 'pdf', 1, 1),
			(105, 10, 'CBZ', 'cbz', 1, 1)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 102, 1, 1)`,
	} {
		if _, err := database.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	for i, entry := range []struct {
		book           int64
		format, digest string
	}{
		{101, "epub", "epub"}, {102, "epub", "hidden"}, {103, "epub", "private"},
		{104, "pdf", "pdf"}, {105, "cbz", "cbz"}, {101, "mobi", "mobi"},
		{101, "azw3", "azw3"}, {101, "fb2", "fb2"}, {101, "fbz", "fbz"},
	} {
		_, err := database.Writer.ExecContext(ctx, `INSERT INTO book_files
			(id, book_id, sha256, format, size_bytes, original_filename, koreader_md5, created_at)
			VALUES (?, ?, ?, ?, 1, ?, ?, 1)`, 201+i, entry.book, fmt.Sprintf("%064d", i),
			entry.format, "book."+entry.format, digest(entry.digest))
		if err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func input(document, progress, deviceID string) Input {
	device, percentage := "PocketBook", 0.375
	return Input{Document: digest(document), Progress: &progress, Percentage: &percentage, Device: &device, DeviceID: deviceID}
}

func digest(name string) string {
	return fmt.Sprintf("%x", md5.Sum([]byte(name)))
}

func (f *fixture) put(t *testing.T, document, position, deviceID string) Record {
	t.Helper()
	record, err := f.service.Put(context.Background(), reading.Viewer{UserID: 2}, input(document, position, deviceID))
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func (f *fixture) count(t *testing.T, query string, args ...any) int64 {
	t.Helper()
	var count int64
	if err := f.db.Reader.QueryRowContext(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func (f *fixture) web(t *testing.T, book, file int64, locator string, updatedAt int64) {
	t.Helper()
	response, err := f.reading.Push(context.Background(), reading.Viewer{UserID: 2}, reading.PushRequest{Mutations: []reading.Mutation{{
		Entity: "reading_progress", ID: fmt.Sprint(book), Op: "upsert", UpdatedAt: &updatedAt,
		Data: json.RawMessage(fmt.Sprintf(`{"book_file_id":%d,"source":"web","percentage":0.8,"locator":%s}`, file, locator)),
	}}})
	if err != nil || response.Results[0].Status != "applied" {
		t.Fatalf("web mutation = %+v, %v", response, err)
	}
}

func TestRawRoundTripUnknownAndUserIsolation(t *testing.T) {
	f := newFixture(t)
	want := f.put(t, "Unknown_digest", " /body/DocFragment[2]/body/p[1].0 \n", "device-1")
	got, err := f.service.Get(context.Background(), reading.Viewer{UserID: 2}, want.Document)
	if err != nil || got == nil || !reflect.DeepEqual(*got, want) {
		t.Fatalf("raw round trip = %+v, %v, want %+v", got, err, want)
	}
	for _, user := range []int64{1, 3} {
		got, err := f.service.Get(context.Background(), reading.Viewer{UserID: user, IsAdmin: user == 1}, want.Document)
		if err != nil || got != nil {
			t.Fatalf("user %d sees another user's record: %+v, %v", user, got, err)
		}
	}
	for _, table := range []string{"reading_progress", "reading_sessions"} {
		if count := f.count(t, "SELECT count(*) FROM "+table); count != 0 {
			t.Fatalf("unknown digest wrote %s: %d", table, count)
		}
	}
}

func TestPutAutomaticReadingStatus(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	viewer := reading.Viewer{UserID: 2}
	f.put(t, "epub", "/body/DocFragment[1]/body/p[1].0", "device")
	state, err := f.reading.GetBookState(ctx, viewer, 101)
	if err != nil || state.UserBook == nil || state.UserBook.Status != "reading" || state.UserBook.StartedAt == nil {
		t.Fatalf("KOReader first progress status = %+v, %v", state.UserBook, err)
	}
	f.now = f.now.Add(time.Second)
	in := input("epub", "/body/DocFragment[9]/body/p[1].0", "device")
	p := 0.99
	in.Percentage = &p
	if _, err := f.service.Put(ctx, viewer, in); err != nil {
		t.Fatal(err)
	}
	state, err = f.reading.GetBookState(ctx, viewer, 101)
	if err != nil || state.UserBook.Status != "finished" || state.UserBook.FinishedAt == nil {
		t.Fatalf("KOReader completion status = %+v, %v", state.UserBook, err)
	}
}

func TestKnownVisibleBridgeAllFormatsAndVisibility(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	for _, document := range []string{"epub", "mobi", "azw3", "fb2", "fbz", "pdf", "cbz", "hidden", "private"} {
		position := "/body/DocFragment[2]/body/p[3].0"
		if document == "pdf" || document == "cbz" {
			position = "00042"
		}
		f.now = f.now.Add(time.Second)
		raw := f.put(t, document, position, "device")
		got, err := f.service.Get(ctx, reading.Viewer{UserID: 2}, digest(document))
		if err != nil || got == nil || *got != raw {
			t.Fatalf("%s roundtrip = %+v, %v", document, got, err)
		}
	}
	if n := f.count(t, "SELECT count(*) FROM reading_progress"); n != 3 {
		t.Fatalf("bridged progress count = %d, want 3 visible books", n)
	}
	if n := f.count(t, "SELECT count(*) FROM reading_sessions"); n != 7 {
		t.Fatalf("session count = %d, want 7 visible files", n)
	}
	state, err := f.reading.GetBookState(ctx, reading.Viewer{UserID: 2}, 104)
	if err != nil || state.Progress == nil || state.Progress.Source != "koreader" ||
		string(state.Progress.Locator) != `{"page":42}` || state.Progress.Percentage != 0.375 {
		t.Fatalf("PDF bridge = %+v, %v", state.Progress, err)
	}
	state, err = f.reading.GetBookState(ctx, reading.Viewer{UserID: 2}, 101)
	if err != nil || state.Progress == nil || string(state.Progress.Locator) != `{"xpointer":"/body/DocFragment[2]/body/p[3].0"}` {
		t.Fatalf("reflowable bridge = %+v, %v", state.Progress, err)
	}
	// Even a newer preexisting web row cannot leak through a hidden digest.
	if _, err := f.db.Writer.ExecContext(ctx, `INSERT INTO reading_progress
		(user_id, book_id, book_file_id, source, locator, percentage, updated_at, rev)
		VALUES (2, 102, 202, 'web', '{"spine":9}', 0.9, ?, 99)`, f.now.Add(time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	raw, _, err := rawRecord(ctx, f.db.Reader, 2, digest("hidden"))
	got, getErr := f.service.Get(ctx, reading.Viewer{UserID: 2}, digest("hidden"))
	if err != nil || getErr != nil || !reflect.DeepEqual(got, raw) {
		t.Fatalf("hidden web leak = %+v, %v / %v", got, getErr, err)
	}
}

func TestFreshnessExactPagesChapterMappingAndSafeFallback(t *testing.T) {
	for _, document := range []string{"epub", "pdf", "cbz"} {
		t.Run(document, func(t *testing.T) {
			f := newFixture(t)
			book, fileID, locator, position := int64(101), int64(201), `{"spine":11,"cfi":"exact-web-cfi"}`, "/body/DocFragment[1]/body/p[7].0"
			if document == "pdf" {
				book, fileID, locator, position = 104, 204, `{"page":42}`, "5"
			} else if document == "cbz" {
				book, fileID, locator, position = 105, 205, `{"page":42}`, "5"
			}
			old := f.put(t, document, position, "eink")
			webTime := f.now.Add(time.Second).UnixMilli()
			f.web(t, book, fileID, locator, webTime)
			get := func() *Record {
				t.Helper()
				got, err := f.service.Get(context.Background(), reading.Viewer{UserID: 2}, digest(document))
				if err != nil || got == nil {
					t.Fatalf("GET = %+v, %v", got, err)
				}
				return got
			}
			got := get()
			if got.Device != "PandaLibrary Web" || got.DeviceID != "" || got.Percentage != 0.8 || got.Timestamp != float64(webTime)/1000 {
				t.Fatalf("web response metadata = %+v", got)
			}
			if document == "epub" {
				if got.Progress != old.Progress {
					t.Fatalf("unvalidated device did not retain last XPointer: %+v", got)
				}
				f.service.options.ChapterXPointer = true
				if got = get(); got.Progress != "/body/DocFragment[12]/body" {
					t.Fatalf("chapter mapping = %+v", got)
				}
			} else if got.Progress != "42" {
				t.Fatalf("exact page mapping = %+v", got)
			}
			raw, _, err := rawRecord(context.Background(), f.db.Reader, 2, digest(document))
			if err != nil || raw == nil || *raw != old {
				t.Fatalf("synthesized GET mutated raw row: %+v, %v", raw, err)
			}
			// A tied or newer raw clock always wins.
			f.now = time.UnixMilli(webTime)
			tied := f.put(t, document, position, "eink")
			if got = get(); *got != tied {
				t.Fatalf("raw tie did not win: %+v", got)
			}
			f.now = f.now.Add(time.Second)
			newer := f.put(t, document, position, "eink")
			if got = get(); *got != newer {
				t.Fatalf("newer device did not win: %+v", got)
			}
		})
	}
}

func TestWebOnlyAndUnusableLocators(t *testing.T) {
	for _, tc := range []struct {
		name, doc, locator string
		book, file         int64
		chapter, want      bool
	}{
		{"web-only-page", "pdf", `{"page":42}`, 104, 204, false, true},
		{"web-only-chapter-disabled", "epub", `{"spine":0}`, 101, 201, false, false},
		{"web-only-chapter-enabled", "epub", `{"spine":0}`, 101, 201, true, true},
		{"different-file", "pdf", `{"page":42}`, 104, 201, false, false},
		{"null", "pdf", `null`, 104, 204, false, false},
		{"opaque", "pdf", `"opaque"`, 104, 204, false, false},
		{"fractional-page", "pdf", `{"page":1.5}`, 104, 204, false, false},
		{"negative-page", "pdf", `{"page":-1}`, 104, 204, false, false},
		{"missing-spine", "epub", `{"cfi":"exact"}`, 101, 201, true, false},
		{"negative-spine", "epub", `{"spine":-1}`, 101, 201, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.service.options.ChapterXPointer = tc.chapter
			file := tc.file
			if tc.name == "different-file" {
				// Add a second physical format of this book; do not make an invalid R1 mutation.
				if _, err := f.db.Writer.Exec(`INSERT INTO book_files
					(id, book_id, sha256, format, size_bytes, original_filename, created_at)
					VALUES (299, 104, ?, 'epub', 1, 'other.epub', 1)`, strings.Repeat("a", 64)); err != nil {
					t.Fatal(err)
				}
				file = 299
			}
			f.web(t, tc.book, file, tc.locator, f.now.UnixMilli())
			got, err := f.service.Get(context.Background(), reading.Viewer{UserID: 2}, digest(tc.doc))
			if err != nil || (got != nil) != tc.want {
				t.Fatalf("web-only GET = %+v, %v", got, err)
			}
		})
	}
}

func TestSessionsBoundaryAlternatingDevicesAndRestart(t *testing.T) {
	f := newFixture(t)
	start := f.now
	f.put(t, "epub", "/body/one", "a")
	f.now = f.now.Add(time.Minute)
	f.put(t, "epub", "/body/two", "b")
	f.now = start.Add(15 * time.Minute)
	// A new adapter instance must still find device A's session after device B pushed.
	restarted, err := NewService(f.db.Writer, f.db.Reader, f.reading, Options{})
	if err != nil {
		t.Fatal(err)
	}
	restarted.now = func() time.Time { return f.now }
	f.service = restarted
	f.put(t, "epub", "/body/three", "a")
	if n := f.count(t, "SELECT count(*) FROM reading_sessions"); n != 2 {
		t.Fatalf("exactly 15 minutes must extend A, session count = %d", n)
	}
	if n := f.count(t, "SELECT active_seconds FROM reading_sessions WHERE started_at = ?", start.UnixMilli()); n != 900 {
		t.Fatalf("extended active seconds = %d", n)
	}
	f.now = f.now.Add(15*time.Minute + time.Millisecond)
	f.put(t, "epub", "/body/four", "a")
	if n := f.count(t, "SELECT count(*) FROM reading_sessions"); n != 3 {
		t.Fatalf("over 15 minutes must start a session, count = %d", n)
	}
	f.put(t, "epub", "/body/five", "a")
	if n := f.count(t, "SELECT count(*) FROM reading_sessions"); n != 3 {
		t.Fatalf("same-time retry created a session, count = %d", n)
	}
}

func TestInvalidInputAndAtomicRollback(t *testing.T) {
	f := newFixture(t)
	for _, tc := range []struct {
		name   string
		mutate func(*Input)
	}{
		{"empty-document", func(i *Input) { i.Document = "" }},
		{"long-document", func(i *Input) { i.Document = strings.Repeat("a", 65) }},
		{"unservable-document", func(i *Input) { i.Document = "a/b" }},
		{"missing-progress", func(i *Input) { i.Progress = nil }},
		{"empty-progress", func(i *Input) { *i.Progress = "" }},
		{"long-progress", func(i *Input) { *i.Progress = strings.Repeat("p", 8193) }},
		{"missing-percentage", func(i *Input) { i.Percentage = nil }},
		{"percentage-underflow", func(i *Input) { *i.Percentage = -0.1 }},
		{"percentage-overflow", func(i *Input) { *i.Percentage = 1.1 }},
		{"percentage-nan", func(i *Input) { *i.Percentage = math.NaN() }},
		{"percentage-infinite", func(i *Input) { *i.Percentage = math.Inf(1) }},
		{"escaped-locator-overflow", func(i *Input) { *i.Progress = strings.Repeat("\x01", 3000) }},
		{"invalid-utf8", func(i *Input) { *i.Progress = "\xff" }},
		{"missing-device", func(i *Input) { i.Device = nil }},
		{"long-device", func(i *Input) { *i.Device = strings.Repeat("d", 129) }},
		{"long-device-id", func(i *Input) { i.DeviceID = strings.Repeat("d", 129) }},
		{"invalid-pdf-page", func(i *Input) { i.Document = digest("pdf"); *i.Progress = "xpointer" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := input("epub", "/body/position", "device")
			tc.mutate(&request)
			if _, err := f.service.Put(context.Background(), reading.Viewer{UserID: 2}, request); !errors.Is(err, ErrInvalid) && !errors.Is(err, ErrDocument) && !errors.Is(err, ErrDocumentNotServable) {
				t.Fatalf("invalid input error = %v", err)
			}

			if n := f.count(t, "SELECT count(*) FROM kosync_progress"); n != 0 {
				t.Fatalf("invalid request persisted %d rows", n)
			}
		})
	}
	// Failure in the final session write rolls back raw progress, R1 progress and revision.
	if _, err := f.db.Writer.Exec(`CREATE TRIGGER reject_session BEFORE INSERT ON reading_sessions
		BEGIN SELECT RAISE(ABORT, 'test session failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Put(context.Background(), reading.Viewer{UserID: 2}, input("epub", "/body/a", "a")); err == nil {
		t.Fatal("expected session write error")
	}
	for _, table := range []string{"kosync_progress", "reading_progress", "reading_sessions"} {
		if n := f.count(t, "SELECT count(*) FROM "+table); n != 0 {
			t.Fatalf("partial transaction left %d %s rows", n, table)
		}
	}
	if n := f.count(t, "SELECT value FROM sync_counter"); n != 0 {
		t.Fatalf("rolled-back revision = %d", n)
	}
}

func TestBridgePreservesReadingLWWAndPublishesRevisions(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	start := f.now
	f.put(t, "epub", "/body/device", "eink")
	pull, err := f.reading.Pull(ctx, reading.Viewer{UserID: 2}, 0)
	if err != nil || len(pull.Progress) != 1 || pull.Progress[0].Source != "koreader" {
		t.Fatalf("KOReader mutation not published to web sync: %+v, %v", pull, err)
	}
	f.web(t, 101, 201, `{"spine":3}`, start.Add(time.Minute).UnixMilli())
	rev := f.count(t, "SELECT value FROM sync_counter")
	// A stale device write still updates its raw record and session, but not R1's newer clock.
	f.now = start.Add(30 * time.Second)
	raw := f.put(t, "epub", "/body/stale-device", "eink")
	if got := f.count(t, "SELECT value FROM sync_counter"); got != rev {
		t.Fatalf("stale bridge changed revision: got %d want %d", got, rev)
	}
	state, err := f.reading.GetBookState(ctx, reading.Viewer{UserID: 2}, 101)
	if err != nil || state.Progress == nil || state.Progress.Source != "web" || state.Progress.Percentage != 0.8 {
		t.Fatalf("stale bridge overwrote newer web progress: %+v, %v", state, err)
	}
	got, err := f.service.Get(ctx, reading.Viewer{UserID: 2}, digest("epub"))
	if err != nil || got == nil || got.Progress != raw.Progress || got.Percentage != 0.8 || got.Device != "PandaLibrary Web" {
		t.Fatalf("newer web safe fallback = %+v, %v", got, err)
	}
	if count := f.count(t, "SELECT count(*) FROM reading_sessions"); count != 1 {
		t.Fatalf("stale bridge split session: %d", count)
	}
	if seconds := f.count(t, "SELECT active_seconds FROM reading_sessions"); seconds != 30 {
		t.Fatalf("stale bridge did not extend session: %d", seconds)
	}
}

func TestAcceptedFieldBoundaries(t *testing.T) {
	f := newFixture(t)
	for _, percentage := range []float64{0, 1} {
		request := input("unused", strings.Repeat("p", 8<<10), strings.Repeat("i", 128))
		request.Document = strings.Repeat("a", 64)
		*request.Device = strings.Repeat("d", 128)
		*request.Percentage = percentage
		record, err := f.service.Put(context.Background(), reading.Viewer{UserID: 2}, request)
		if err != nil {
			t.Fatalf("valid boundary rejected: %v", err)
		}
		got, err := f.service.Get(context.Background(), reading.Viewer{UserID: 2}, request.Document)
		if err != nil || got == nil || *got != record {
			t.Fatalf("boundary roundtrip = %+v, %v", got, err)
		}
	}
}
