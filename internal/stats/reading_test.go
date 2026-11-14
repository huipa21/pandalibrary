package stats

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestReadingLocalCalendarAndHours(t *testing.T) {
	f := newStatsFixture(t)
	for _, entry := range []struct {
		at     string
		active int64
	}{
		{"2023-12-31T16:00:00Z", 10},
		{"2024-01-31T15:59:00Z", 120},
		{"2024-01-31T16:00:00Z", 20},
		{"2024-02-29T04:00:00Z", 30},
		{"2024-12-31T15:59:59Z", 40},
		{"2024-12-31T16:00:00Z", 1000},
	} {
		f.session(t, 2, 101, instant(t, entry.at), entry.active)
	}
	got, err := f.service.Reading(context.Background(), Viewer{UserID: 2}, 2024, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if got.Year != 2024 || got.Timezone != "Asia/Shanghai" || len(got.Daily) != 366 ||
		got.Daily[0].Date != "2024-01-01" || got.Daily[365].Date != "2024-12-31" ||
		len(got.Hours) != 288 || got.Completions == nil {
		t.Fatalf("invalid calendar: %+v", got)
	}
	for _, want := range []Day{
		{Date: "2024-01-01", ActiveSeconds: 10, SessionCount: 1},
		{Date: "2024-01-31", ActiveSeconds: 120, SessionCount: 1},
		{Date: "2024-02-01", ActiveSeconds: 20, SessionCount: 1},
		{Date: "2024-02-29", ActiveSeconds: 30, SessionCount: 1},
		{Date: "2024-12-31", ActiveSeconds: 40, SessionCount: 1},
	} {
		found := false
		for _, day := range got.Daily {
			if day.Date == want.Date {
				found = true
				if day != want {
					t.Errorf("day = %+v, want %+v", day, want)
				}
			}
		}
		if !found {
			t.Errorf("missing date %s", want.Date)
		}
	}
	for _, want := range []ReadingHour{
		{Month: 1, Hour: 0, ActiveSeconds: 10, SessionCount: 1},
		{Month: 1, Hour: 23, ActiveSeconds: 120, SessionCount: 1},
		{Month: 2, Hour: 0, ActiveSeconds: 20, SessionCount: 1},
		{Month: 2, Hour: 12, ActiveSeconds: 30, SessionCount: 1},
		{Month: 12, Hour: 23, ActiveSeconds: 40, SessionCount: 1},
	} {
		if hour := got.Hours[(want.Month-1)*24+want.Hour]; hour != want {
			t.Errorf("hour = %+v, want %+v", hour, want)
		}
	}
	empty, err := f.service.Reading(context.Background(), Viewer{UserID: 2}, 2025, "UTC")
	if err != nil || len(empty.Daily) != 365 {
		t.Fatalf("non-leap calendar = %d, %v", len(empty.Daily), err)
	}
}

func TestReadingFinishedCountsDurationsAndVisibility(t *testing.T) {
	f := newStatsFixture(t)
	f.exec(t, `INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
		(105, 10, 'Skimmed', 'skimmed', 1, 1), (106, 10, 'Abandoned', 'abandoned', 1, 1),
		(107, 10, 'Planned', 'planned', 1, 1), (108, 10, 'Reading', 'reading', 1, 1),
		(109, 10, 'Earlier cycle', 'earlier', 1, 1), (110, 10, 'Same day', 'same', 1, 1),
		(111, 10, 'Invalid start', 'invalid', 1, 1), (112, 10, 'Owner only', 'owner', 1, 1),
		(113, 10, 'Public', 'public', 1, 1), (114, 10, 'Own', 'own', 1, 1)`)
	f.exec(t, `UPDATE books SET visibility = 'private', owner_id = 3 WHERE id = 112`)
	f.exec(t, `UPDATE books SET visibility = 'private', owner_id = 2 WHERE id = 114`)
	f.exec(t, `UPDATE books SET visibility = 'public' WHERE id = 113`)
	finish := instant(t, "2024-03-10T16:00:00Z")
	start := instant(t, "2024-03-09T16:00:00Z")
	for book, status := range map[int64]string{
		101: "finished", 102: "finished", 103: "finished", 104: "finished",
		105: "skimmed", 106: "abandoned", 107: "want_to_read", 108: "reading",
		109: "reading", 110: "finished", 111: "finished", 112: "finished",
		113: "finished", 114: "finished",
	} {
		f.finish(t, 2, book, finish, status)
		f.session(t, 2, book, finish, 60)
	}
	f.exec(t, `UPDATE user_books SET started_at = ? WHERE book_id IN (101, 102, 103, 112, 113, 114)`, start)
	f.exec(t, `UPDATE user_books SET started_at = ? WHERE book_id = 110`, finish)
	f.exec(t, `UPDATE user_books SET started_at = ? WHERE book_id = 111`, finish+1000)
	f.archive(t, 2, 101, finish-86400000, "finished")
	f.archive(t, 2, 101, finish-2*86400000, "finished")
	f.archive(t, 2, 105, finish, "skimmed")
	f.archive(t, 2, 106, finish, "abandoned")
	f.archive(t, 2, 109, finish-86400000, "finished")
	f.archive(t, 2, 109, finish+86400000, "finished")
	f.exec(t, `UPDATE reading_cycles SET started_at = ended_at + 1000
		WHERE book_id = 109 AND ended_at = ?`, finish+86400000)
	f.session(t, 3, 101, finish, 10000)
	got, err := f.service.Reading(context.Background(), Viewer{UserID: 2}, 2024, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if got.Books != (ReadingBooks{Read: 7, ReadAndReading: 8}) {
		t.Errorf("books = %+v", got.Books)
	}
	want := []ReadingCompletion{
		{BookID: 109, Title: "Earlier cycle", StartedOn: "2024-03-09", FinishedOn: "2024-03-10", Days: 1},
		{BookID: 101, Title: "Visible", StartedOn: "2024-03-10", FinishedOn: "2024-03-11", Days: 1},
		{BookID: 110, Title: "Same day", StartedOn: "2024-03-11", FinishedOn: "2024-03-11", Days: 0},
		{BookID: 113, Title: "Public", StartedOn: "2024-03-10", FinishedOn: "2024-03-11", Days: 1},
		{BookID: 114, Title: "Own", StartedOn: "2024-03-10", FinishedOn: "2024-03-11", Days: 1},
	}
	for i := range want {
		want[i].Progress = []ReadingProgressPoint{}
		if want[i].BookID != 109 {
			want[i].FirstSessionOn = "2024-03-11"
		}
	}
	if !reflect.DeepEqual(got.Completions, want) {
		t.Errorf("completions = %+v, want %+v", got.Completions, want)
	}

	var sessions int64
	for _, day := range got.Daily {
		sessions += day.SessionCount
	}
	if sessions != 11 {
		t.Errorf("visible sessions = %d", sessions)
	}
	ungranted, err := f.service.Reading(context.Background(), Viewer{UserID: 4}, 2024, "UTC")
	if err != nil || ungranted.Books.Read != 0 || len(ungranted.Completions) != 0 {
		t.Fatalf("ungranted stats = %+v, %v", ungranted.Books, err)
	}
}

func TestReadingRecordedCompletionProgress(t *testing.T) {
	f := newStatsFixture(t)
	start := instant(t, "2023-12-29T16:00:00Z")
	finish := instant(t, "2024-01-03T16:00:00Z")
	f.finish(t, 2, 101, finish, "finished")
	f.exec(t, `UPDATE user_books SET started_at = ? WHERE book_id = 101`, start)
	// No-percentage sessions still establish the first-session calendar day.
	f.session(t, 2, 101, start, 60)
	for _, entry := range []struct {
		user     int64
		at       string
		from, to any
	}{
		{2, "2023-12-29T15:00:00Z", 0.0, 0.9}, // Outside the selected lifecycle.
		{2, "2023-12-31T15:59:30Z", 0.0, 0.25},
		{2, "2024-01-02T03:00:00Z", nil, 0.2},  // Keep real regressions and null endpoints.
		{2, "2024-01-03T15:59:30Z", 0.5, 0.75}, // End is after completion: do not use it.
		{2, "2024-01-04T03:00:00Z", 0.8, 1.0},  // After completion.
		{3, "2024-01-01T03:00:00Z", 0.8, 1.0},  // Another viewer.
	} {
		at := instant(t, entry.at)
		f.session(t, entry.user, 101, at, 60)
		f.exec(t, `UPDATE reading_sessions SET start_percentage = ?, end_percentage = ?
				WHERE user_id = ? AND book_id = 101 AND started_at = ?`, entry.from, entry.to, entry.user, at)
	}
	got, err := f.service.Reading(context.Background(), Viewer{UserID: 2}, 2024, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Completions) != 1 {
		t.Fatalf("completions = %+v", got.Completions)
	}
	book := got.Completions[0]
	want := []ReadingProgressPoint{
		{Days: 1, Percentage: 0, RecordedOn: "2023-12-31"},
		{Days: 2, Percentage: 0.25, RecordedOn: "2024-01-01"},
		{Days: 3, Percentage: 0.2, RecordedOn: "2024-01-02"},
		{Days: 4, Percentage: 0.5, RecordedOn: "2024-01-03"},
	}
	if book.FirstSessionOn != "2023-12-30" || !reflect.DeepEqual(book.Progress, want) {
		t.Errorf("recorded progress = %+v, want %+v", book, want)
	}
	other, err := f.service.Reading(context.Background(), Viewer{UserID: 2}, 2023, "Asia/Shanghai")
	if err != nil || len(other.Completions) != 0 {
		t.Fatalf("completion-year filtering = %+v, %v", other.Completions, err)
	}
}

func TestReadingValidation(t *testing.T) {
	f := newStatsFixture(t)
	for _, test := range []struct {
		viewer Viewer
		year   int
		zone   string
	}{
		{Viewer{}, 2024, "UTC"},
		{Viewer{UserID: 2}, 0, "UTC"},
		{Viewer{UserID: 2}, 9999, "UTC"},
		{Viewer{UserID: 2}, 2024, "Local"},
		{Viewer{UserID: 2}, 2024, "Invalid/Zone"},
	} {
		if _, err := f.service.Reading(context.Background(), test.viewer, test.year, test.zone); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: %v", test, err)
		}

	}
}

func TestReadingProgressCalendarDays(t *testing.T) {
	for _, test := range []struct {
		name, start, finish, zone string
		days                      int
	}{
		{"same-day", "2024-03-10T12:00:00Z", "2024-03-10T12:01:00Z", "UTC", 0},
		{"DST", "2024-03-10T05:00:00Z", "2024-03-11T04:00:00Z", "America/New_York", 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newStatsFixture(t)
			start, finish := instant(t, test.start), instant(t, test.finish)
			f.finish(t, 2, 101, finish, "finished")
			f.exec(t, `UPDATE user_books SET started_at = ? WHERE book_id = 101`, start)
			f.session(t, 2, 101, start, (finish-start)/1000)
			f.exec(t, `UPDATE reading_sessions SET start_percentage = 0, end_percentage = 0.75`)
			got, err := f.service.Reading(context.Background(), Viewer{UserID: 2}, 2024, test.zone)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Completions) != 1 {
				t.Fatalf("completions = %+v", got.Completions)
			}
			book := got.Completions[0]
			if book.Days != test.days || len(book.Progress) != 2 ||
				book.Progress[0].Days != 0 || book.Progress[0].Percentage != 0 ||
				book.Progress[1].Days != test.days || book.Progress[1].Percentage != 0.75 {
				t.Errorf("calendar progress = %+v", book)
			}
		})
	}
}
