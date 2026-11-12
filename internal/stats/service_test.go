package stats

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

type statsFixture struct {
	service *Service
	db      *db.DB
	nextID  int
}

func newStatsFixture(t *testing.T) *statsFixture {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "stats.db")
	databases, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close databases: %v", err)
		}
	})
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	service, err := NewService(databases.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &statsFixture{service: service, db: databases}
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1), (2, 'reader', 'x', 'user', 1, 1),
			(3, 'other', 'x', 'user', 1, 1), (4, 'ungranted', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1), (20, 3, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(101, 10, 'Visible', 'visible', 1, 1), (102, 10, 'Hidden', 'hidden', 1, 1),
			(103, 20, 'Private', 'private', 1, 1), (104, 10, 'Second', 'second', 1, 1)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES
			(2, 102, 1, 1), (1, 102, 1, 1)`,
		`INSERT INTO authors (id, name, sort_name, created_at) VALUES
			(1, 'Later', 'later', 1), (2, 'First', 'first', 1), (3, 'Translator', 'translator', 1)`,
		`INSERT INTO book_authors (book_id, author_id, role, position) VALUES
			(101, 1, 'author', 2), (101, 2, 'author', 1), (101, 3, 'translator', 0)`,
	} {
		fixture.exec(t, statement)
	}
	return fixture
}

func (f *statsFixture) exec(t *testing.T, statement string, args ...any) {
	t.Helper()
	if _, err := f.db.Writer.ExecContext(context.Background(), statement, args...); err != nil {
		t.Fatal(err)
	}
}

func instant(t *testing.T, value string) int64 {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed.UnixMilli()
}

func (f *statsFixture) session(t *testing.T, user, book, start, active int64) {
	t.Helper()
	f.nextID++
	f.exec(t, `INSERT INTO reading_sessions
		(id, user_id, book_id, source, started_at, ended_at, active_seconds, created_at)
		VALUES (?, ?, ?, 'web', ?, ?, ?, ?)`,
		fmt.Sprintf("00000000-0000-7000-8000-%012d", f.nextID),
		user, book, start, start+active*1000, active, start)
}

func (f *statsFixture) finish(t *testing.T, user, book, at int64, status string) {
	t.Helper()
	f.exec(t, `INSERT INTO user_books (user_id, book_id, status, finished_at, updated_at, rev)
		VALUES (?, ?, ?, ?, 1, 1)`, user, book, status, at)
}

func (f *statsFixture) archive(t *testing.T, user, book, at int64, status string) {
	t.Helper()
	f.exec(t, `INSERT INTO reading_cycles (user_id, book_id, started_at, ended_at, status, percentage)
		VALUES (?, ?, ?, ?, ?, 1)`, user, book, at-1000, at, status)
}

func TestCalendarValidation(t *testing.T) {
	for _, test := range []struct {
		from, to, zone string
	}{
		{"", "2026-01-01", "UTC"},
		{"2026-01-01", "", "UTC"},
		{"2026-02-29", "2026-03-01", "UTC"},
		{"2026-01-01", "2026-02-30", "UTC"},
		{"2026-1-01", "2026-01-01", "UTC"},
		{"0000-01-01", "0000-01-01", "UTC"},
		{"2026-01-02", "2026-01-01", "UTC"},
		{"2024-01-01", "2025-01-01", "UTC"},
		{"2026-01-01", "2026-01-01", ""},
		{"2026-01-01", "2026-01-01", "Local"},
		{"2026-01-01", "2026-01-01", "Unknown/Zone"},
		{"2026-01-01", "2026-01-01", "../UTC"},
		{"2026-01-01", "2026-01-01", " UTC"},
	} {
		t.Run(test.from+"/"+test.to+"/"+test.zone, func(t *testing.T) {
			if _, err := parseCalendar(test.from, test.to, test.zone); !errors.Is(err, ErrInvalid) {
				t.Fatalf("error = %v, want invalid", err)
			}
		})
	}
	for _, zone := range []string{"UTC", "Asia/Shanghai", "Asia/Kathmandu", "America/New_York"} {
		cal, err := parseCalendar("2024-01-01", "2024-12-31", zone)
		if err != nil || len(cal.days) != 366 {
			t.Fatalf("366-day calendar in %s = %d days, %v", zone, len(cal.days), err)
		}
	}
	if _, err := NewService(nil); err == nil {
		t.Fatal("nil reader accepted")
	}
}

func TestLocalMidnightsUseIANAOffsets(t *testing.T) {
	for _, test := range []struct {
		date, zone, start, end string
		hours                  int64
	}{
		{"2026-03-08", "America/New_York", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z", 23},
		{"2026-11-01", "America/New_York", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", 25},
		{"2018-11-04", "America/Sao_Paulo", "2018-11-04T03:00:00Z", "2018-11-05T02:00:00Z", 23},
		{"2020-11-01", "America/Havana", "2020-11-01T04:00:00Z", "2020-11-02T05:00:00Z", 25},
		{"2011-12-30", "Pacific/Apia", "2011-12-30T10:00:00Z", "2011-12-30T10:00:00Z", 0},
		{"2026-01-01", "Asia/Kathmandu", "2025-12-31T18:15:00Z", "2026-01-01T18:15:00Z", 24},
	} {
		t.Run(test.zone+"/"+test.date, func(t *testing.T) {
			cal, err := parseCalendar(test.date, test.date, test.zone)
			if err != nil {
				t.Fatal(err)
			}
			day := cal.days[0]
			if day.Start != instant(t, test.start) || day.End != instant(t, test.end) ||
				day.End-day.Start != test.hours*3600000 {
				t.Fatalf("boundaries = %+v, want %s to %s (%dh)", day, test.start, test.end, test.hours)
			}
		})
	}
}

func TestDailyDSTBoundariesAndSessionAttribution(t *testing.T) {
	for _, test := range []struct {
		date, start, end string
	}{
		{"2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"},
		{"2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"},
	} {
		t.Run(test.date, func(t *testing.T) {
			f := newStatsFixture(t)
			start, end := instant(t, test.start), instant(t, test.end)
			f.session(t, 2, 101, start-1, 999)
			f.session(t, 2, 101, start, 30)
			// A session ending outside the range is wholly attributed to its start.
			f.session(t, 2, 101, end-1, 90)
			f.session(t, 2, 101, end, 888)
			f.session(t, 3, 101, start, 777)
			got, err := f.service.Get(context.Background(), Viewer{UserID: 2}, test.date, test.date, "America/New_York")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.Daily, []Day{{Date: test.date, ActiveSeconds: 120, SessionCount: 2}}) ||
				len(got.TimePerBook) != 1 || got.TimePerBook[0].ActiveSeconds != 120 ||
				got.TimePerBook[0].SessionCount != 2 || got.Streaks != (Streaks{CurrentDays: 2, LongestDays: 2}) {
				t.Fatalf("stats = %+v", got)
			}
		})
	}
}

func TestZeroFillMonthsAuthorsAndDeterministicBookOrder(t *testing.T) {
	f := newStatsFixture(t)
	start := instant(t, "2026-01-30T16:00:00Z")
	f.session(t, 2, 101, start, 30)
	f.session(t, 2, 104, start, 30)
	f.session(t, 2, 104, start+1, 0)
	f.finish(t, 2, 101, start, "finished")
	f.finish(t, 2, 104, instant(t, "2026-02-01T15:59:59.999Z"), "finished")
	f.finish(t, 3, 101, start, "finished")
	got, err := f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-31", "2026-02-01", "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if got.Timezone != "Asia/Shanghai" || got.From != "2026-01-31" || got.To != "2026-02-01" ||
		!reflect.DeepEqual(got.Daily, []Day{
			{Date: "2026-01-31", ActiveSeconds: 60, SessionCount: 3}, {Date: "2026-02-01"},
		}) || !reflect.DeepEqual(got.FinishedPerMonth, []FinishedMonth{
		{Month: "2026-01", BooksFinished: 1}, {Month: "2026-02", BooksFinished: 1},
	}) || !reflect.DeepEqual(got.TimePerBook, []BookTime{
		{BookID: 101, Title: "Visible", Authors: []string{"First", "Later"}, ActiveSeconds: 30, SessionCount: 1},
		{BookID: 104, Title: "Second", Authors: []string{}, ActiveSeconds: 30, SessionCount: 2},
	}) || got.Streaks != (Streaks{LongestDays: 1}) {
		t.Fatalf("stats = %+v", got)
	}
	// Counts use current status, not a stale finished_at on a now-reading book.
	f.exec(t, "UPDATE user_books SET status = 'reading' WHERE user_id = 2 AND book_id = 101")
	got, err = f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-31", "2026-02-01", "Asia/Shanghai")
	if err != nil || got.FinishedPerMonth[0].BooksFinished != 0 {
		t.Fatalf("current status stats = %+v, %v", got, err)
	}
	f.exec(t, "UPDATE user_books SET finished_at = ? WHERE user_id = 2 AND book_id = 104",
		instant(t, "2026-02-01T16:00:00Z"))
	got, err = f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-31", "2026-02-01", "Asia/Shanghai")
	if err != nil || got.FinishedPerMonth[1].BooksFinished != 0 {
		t.Fatalf("exclusive finished boundary = %+v, %v", got, err)
	}
}

func TestTerminalStatusesCountOncePerCycle(t *testing.T) {
	f := newStatsFixture(t)
	at := instant(t, "2026-01-15T12:00:00Z")
	f.finish(t, 2, 101, at, "finished")
	f.exec(t, `INSERT INTO user_books (user_id, book_id, status, updated_at, rev)
		VALUES (2, 104, 'abandoned', ?, 1)`, at)
	for _, status := range []string{"finished", "skimmed", "abandoned", "finished"} {
		f.exec(t, `UPDATE user_books SET status = ?, updated_at = ? WHERE user_id = 2 AND book_id = 101`,
			status, instant(t, "2026-02-01T12:00:00Z"))
		got, err := f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-01", "2026-02-28", "UTC")
		if err != nil || !reflect.DeepEqual(got.FinishedPerMonth, []FinishedMonth{
			{Month: "2026-01", BooksFinished: 2}, {Month: "2026-02"},
		}) {
			t.Fatalf("%s cycle counts = %+v, %v", status, got.FinishedPerMonth, err)
		}
	}
}

func TestFinishedCyclesSurviveRepeatedRereading(t *testing.T) {
	f := newStatsFixture(t)
	f.archive(t, 2, 101, instant(t, "2026-01-31T15:59:59.999Z"), "finished")
	f.archive(t, 2, 101, instant(t, "2026-01-31T16:00:00Z"), "skimmed")
	f.finish(t, 2, 101, instant(t, "2026-02-28T16:00:00Z"), "abandoned")
	want := []FinishedMonth{
		{Month: "2026-01", BooksFinished: 1},
		{Month: "2026-02", BooksFinished: 1},
		{Month: "2026-03", BooksFinished: 1},
	}
	got, err := f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-01", "2026-03-31", "Asia/Shanghai")
	if err != nil || !reflect.DeepEqual(got.FinishedPerMonth, want) {
		t.Fatalf("three cycles = %+v, %v", got.FinishedPerMonth, err)
	}
	f.archive(t, 2, 101, instant(t, "2026-02-28T16:00:00Z"), "abandoned")
	f.exec(t, `UPDATE user_books SET status = 'rereading', finished_at = NULL WHERE user_id = 2 AND book_id = 101`)
	got, err = f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-01", "2026-03-31", "Asia/Shanghai")
	if err != nil || !reflect.DeepEqual(got.FinishedPerMonth, want) {
		t.Fatalf("reset preserves cycles = %+v, %v", got.FinishedPerMonth, err)
	}
}

func TestSessionsAfterFinishingCountWithoutRefinishing(t *testing.T) {
	f := newStatsFixture(t)
	f.archive(t, 2, 101, instant(t, "2025-12-20T12:00:00Z"), "finished")
	f.finish(t, 2, 101, instant(t, "2026-01-10T08:00:00Z"), "finished")
	f.finish(t, 2, 104, instant(t, "2026-01-10T09:00:00Z"), "skimmed")
	f.session(t, 2, 101, instant(t, "2026-01-10T10:00:00Z"), 60)
	f.session(t, 2, 101, instant(t, "2026-01-11T10:00:00Z"), 120)
	f.session(t, 2, 104, instant(t, "2026-01-11T11:00:00Z"), 30)
	f.session(t, 2, 104, instant(t, "2026-01-12T10:00:00Z"), 45)
	got, err := f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-10", "2026-01-12", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Daily, []Day{
		{Date: "2026-01-10", ActiveSeconds: 60, SessionCount: 1},
		{Date: "2026-01-11", ActiveSeconds: 150, SessionCount: 2},
		{Date: "2026-01-12", ActiveSeconds: 45, SessionCount: 1},
	}) || got.Streaks != (Streaks{CurrentDays: 3, LongestDays: 3}) ||
		!reflect.DeepEqual(got.FinishedPerMonth, []FinishedMonth{{Month: "2026-01", BooksFinished: 2}}) {
		t.Fatalf("post-finish stats = %+v", got)
	}
}

func TestStreaksUseDistinctPositiveDaysAndHistoryThroughTo(t *testing.T) {
	f := newStatsFixture(t)
	for _, date := range []string{
		"2025-12-27", "2025-12-28", "2025-12-29", "2025-12-30",
		"2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05",
	} {
		f.session(t, 2, 101, instant(t, date+"T00:00:00Z"), 30)
	}
	f.session(t, 2, 101, instant(t, "2026-01-03T12:00:00Z"), 60)
	f.session(t, 2, 101, instant(t, "2026-01-01T00:00:00Z"), 0)
	f.session(t, 2, 102, instant(t, "2025-12-31T00:00:00Z"), 99)
	got, err := f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-03", "2026-01-03", "UTC")
	if err != nil || got.Streaks != (Streaks{CurrentDays: 2, LongestDays: 4}) {
		t.Fatalf("history streaks = %+v, %v", got, err)
	}
	got, err = f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-01", "2026-01-01", "UTC")
	if err != nil || got.Streaks != (Streaks{LongestDays: 4}) || got.Daily[0].SessionCount != 1 {
		t.Fatalf("zero-time day streaks = %+v, %v", got, err)
	}
	// No timezone intervals should be built for future dates without activity.
	got, err = f.service.Get(context.Background(), Viewer{UserID: 2}, "9999-12-31", "9999-12-31", "America/New_York")
	if err != nil || got.Streaks != (Streaks{LongestDays: 4}) {
		t.Fatalf("future range streaks = %+v, %v", got, err)
	}
}

func TestStreaksUseLocalDatesIncludingHistoricalOffsets(t *testing.T) {
	for _, test := range []struct {
		zone, from, to, first, second string
	}{
		{"America/New_York", "2026-01-01", "2026-01-01", "2026-01-01T00:30:00Z", "2026-01-01T23:30:00Z"},
		// New York used a seconds-resolution local mean time before standard time.
		{"America/New_York", "1880-01-01", "1880-01-01", "1880-01-01T00:30:00Z", "1880-01-01T23:30:00Z"},
		{"Asia/Kathmandu", "2026-01-01", "2026-01-01", "2025-12-31T18:14:59Z", "2025-12-31T18:15:00Z"},
	} {
		t.Run(test.zone+"/"+test.to, func(t *testing.T) {
			f := newStatsFixture(t)
			f.session(t, 2, 101, instant(t, test.first), 30)
			f.session(t, 2, 101, instant(t, test.second), 30)
			got, err := f.service.Get(context.Background(), Viewer{UserID: 2}, test.from, test.to, test.zone)
			if err != nil || got.Streaks != (Streaks{CurrentDays: 2, LongestDays: 2}) ||
				got.Daily[0].SessionCount != 1 {
				t.Fatalf("local date stats = %+v, %v", got, err)
			}
		})
	}
}

func TestHistoryZonesCrossLeapYearAndHonorBounds(t *testing.T) {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	start, end := instant(t, "2024-12-30T00:00:00Z"), instant(t, "2025-03-10T00:00:00Z")
	encoded, err := historyZones(context.Background(), start, end, location)
	if err != nil {
		t.Fatal(err)
	}
	var zones []zoneInterval
	if err := json.Unmarshal([]byte(encoded), &zones); err != nil {
		t.Fatal(err)
	}
	cursor := start
	for _, zone := range zones {
		if zone.Start != cursor || zone.End <= zone.Start || zone.End > end {
			t.Fatalf("noncontiguous timezone interval: %+v", zone)
		}
		for _, at := range []int64{zone.Start, zone.End - 1} {
			_, offset := time.UnixMilli(at).In(location).Zone()
			if zone.Offset != int64(offset)*1000 {
				t.Fatalf("wrong offset at %v: %+v", time.UnixMilli(at), zone)
			}
		}
		cursor = zone.End
	}
	if cursor != end {
		t.Fatalf("intervals end at %d, want %d", cursor, end)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := historyZones(canceled, start, end, location); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled timezone calculation = %v", err)
	}
	if _, err := historyZones(context.Background(), start, time.Date(15000, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(), location); err == nil {
		t.Fatal("unbounded timezone history accepted")
	}
}

func TestEveryStatsAggregateUsesCurrentVisibilityAndOwnership(t *testing.T) {
	for _, test := range []struct {
		name   string
		viewer Viewer
		books  []int64
	}{
		{"reader", Viewer{UserID: 2}, []int64{101, 104}},
		{"admin", Viewer{UserID: 1, IsAdmin: true}, []int64{101, 103, 104}},
		{"ungranted", Viewer{UserID: 4}, []int64{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newStatsFixture(t)
			at := instant(t, "2026-01-02T00:00:00Z")
			for _, user := range []int64{1, 2, 4} {
				for _, book := range []int64{101, 102, 103, 104} {
					f.session(t, user, book, at, 30)
					f.finish(t, user, book, at, "finished")
					f.archive(t, user, book, at+1, "skimmed")
				}
				// Invisible history must not lengthen either streak.
				f.session(t, user, 102, at-86400000, 50)
			}
			f.session(t, 3, 101, at, 1000)
			got, err := f.service.Get(context.Background(), test.viewer, "2026-01-02", "2026-01-02", "UTC")
			if err != nil {
				t.Fatal(err)
			}
			ids := []int64{}
			for _, book := range got.TimePerBook {
				ids = append(ids, book.BookID)
			}
			count := int64(len(test.books))
			wantStreak := Streaks{}
			if count > 0 {
				wantStreak = Streaks{CurrentDays: 1, LongestDays: 1}
			}
			if !reflect.DeepEqual(ids, test.books) || got.Daily[0].ActiveSeconds != 30*count ||
				got.Daily[0].SessionCount != count || got.FinishedPerMonth[0].BooksFinished != 2*count ||
				got.Streaks != wantStreak {
				t.Fatalf("visibility stats = %+v, book IDs %v", got, ids)
			}
			if test.name == "reader" {
				f.exec(t, "DELETE FROM library_access WHERE user_id = 2")
				got, err = f.service.Get(context.Background(), test.viewer, "2026-01-02", "2026-01-02", "UTC")
				if err != nil || len(got.TimePerBook) != 0 || got.Daily[0].SessionCount != 0 ||
					got.FinishedPerMonth[0].BooksFinished != 0 || got.Streaks != (Streaks{}) {
					t.Fatalf("revoked visibility stats = %+v, %v", got, err)
				}
			}
		})
	}
}

func TestStatsEmptyErrorsAndLimits(t *testing.T) {
	f := newStatsFixture(t)
	ctx := context.Background()
	got, err := f.service.Get(ctx, Viewer{UserID: 2}, "2026-01-01", "2026-02-01", "UTC")
	if err != nil || len(got.Daily) != 32 || len(got.FinishedPerMonth) != 2 ||
		got.TimePerBook == nil || got.Streaks != (Streaks{}) {
		t.Fatalf("empty stats = %+v, %v", got, err)
	}
	encoded, err := json.Marshal(got)
	if err != nil || len(encoded) == 0 {
		t.Fatalf("encode DTO: %s, %v", encoded, err)
	}
	if _, err := f.service.Get(ctx, Viewer{}, "2026-01-01", "2026-01-01", "UTC"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid viewer = %v", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := f.service.Get(canceled, Viewer{UserID: 2}, "2026-01-01", "2026-01-01", "UTC"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled stats = %v", err)
	}
	// Aggregate overflow is a database failure, not a successful zero count.
	at := instant(t, "2026-01-01T00:00:00Z")
	f.exec(t, `INSERT INTO reading_sessions
		(id, user_id, book_id, source, started_at, ended_at, active_seconds, created_at)
		VALUES ('00000000-0000-7000-8000-000000000001', 2, 101, 'web', ?, ?, 9223372036854775807, 1),
		       ('00000000-0000-7000-8000-000000000002', 2, 101, 'web', ?, ?, 1, 1)`, at, at, at, at)
	if _, err := f.service.Get(ctx, Viewer{UserID: 2}, "2026-01-01", "2026-01-01", "UTC"); err == nil {
		t.Fatal("overflow returned success")
	}
	f.exec(t, "DELETE FROM reading_sessions")
	if err := f.db.Reader.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Get(ctx, Viewer{UserID: 2}, "2026-01-01", "2026-01-01", "UTC"); err == nil {
		t.Fatal("closed database returned success")
	}
}

func TestBookResultLimitFailsWithoutTruncation(t *testing.T) {
	f := newStatsFixture(t)
	at := instant(t, "2026-01-01T00:00:00Z")
	f.exec(t, `WITH RECURSIVE n(id) AS (SELECT 1000 UNION ALL SELECT id + 1 FROM n WHERE id < 1999)
		 INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
		 SELECT id, 10, 'Book', 'book', 1, 1 FROM n`)
	f.exec(t, `INSERT INTO reading_sessions (id, user_id, book_id, source, started_at, ended_at, active_seconds, created_at)
		 SELECT printf('00000000-0000-7000-8000-%012d', id), 2, id, 'web', ?, ?, 1, 1
		 FROM books WHERE id >= 1000`, at, at)
	got, err := f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-01", "2026-01-01", "UTC")
	if err != nil || len(got.TimePerBook) != maxBooks {
		t.Fatalf("1000 books = %d, %v", len(got.TimePerBook), err)
	}
	f.session(t, 2, 101, at, 1)
	if _, err := f.service.Get(context.Background(), Viewer{UserID: 2}, "2026-01-01", "2026-01-01", "UTC"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("1001 books error = %v", err)
	}
}
