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
