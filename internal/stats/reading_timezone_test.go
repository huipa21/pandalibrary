package stats

import (
	"context"
	"errors"
	"testing"
)

func TestReadingDSTAndCalendarDuration(t *testing.T) {
	f := newStatsFixture(t)
	start := instant(t, "2024-03-10T05:00:00Z")
	finish := instant(t, "2024-03-11T04:00:00Z")
	f.finish(t, 2, 101, finish, "finished")
	f.exec(t, `UPDATE user_books SET started_at = ? WHERE book_id = 101`, start)
	for _, at := range []string{"2024-11-03T05:30:00Z", "2024-11-03T06:30:00Z"} {
		f.session(t, 2, 101, instant(t, at), 60)
	}
	got, err := f.service.Reading(context.Background(), Viewer{UserID: 2}, 2024, "America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	hour := got.Hours[10*24+1]
	if hour.ActiveSeconds != 120 || hour.SessionCount != 2 {
		t.Errorf("repeated hour = %+v", hour)
	}
	if len(got.Completions) != 1 || got.Completions[0].Days != 1 ||
		got.Completions[0].StartedOn != "2024-03-10" || got.Completions[0].FinishedOn != "2024-03-11" {
		t.Errorf("23-hour calendar duration = %+v", got.Completions)
	}
}

func TestReadingCompletionBounds(t *testing.T) {
	f := newStatsFixture(t)
	f.exec(t, `WITH RECURSIVE ids(id) AS (
		SELECT 1000 UNION ALL SELECT id + 1 FROM ids WHERE id < 2000
	)
	INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
	SELECT id, 10, 'Book', 'book', 1, 1 FROM ids`)
	f.exec(t, `INSERT INTO user_books (user_id, book_id, status, started_at, finished_at, updated_at, rev)
		SELECT 2, id, 'finished', ?, ?, 1, 1 FROM books WHERE id >= 1000`,
		instant(t, "2024-01-01T00:00:00Z"), instant(t, "2024-01-02T00:00:00Z"))
	if _, err := f.service.Reading(context.Background(), Viewer{UserID: 2}, 2024, "UTC"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("overlarge completions = %v", err)
	}
}

func TestReadingFirstYearAndPreEpochHours(t *testing.T) {
	f := newStatsFixture(t)
	start := instant(t, "0001-01-01T00:00:00+08:00")
	f.session(t, 2, 101, start, 60)
	f.finish(t, 2, 101, start, "finished")
	f.exec(t, `UPDATE user_books SET started_at = ? WHERE book_id = 101`, start)
	got, err := f.service.Reading(context.Background(), Viewer{UserID: 2}, 1, "Etc/GMT-8")
	if err != nil {
		t.Fatal(err)
	}
	if got.Daily[0].ActiveSeconds != 60 || got.Hours[0].ActiveSeconds != 60 ||
		len(got.Completions) != 1 || got.Completions[0].Days != 0 ||
		got.Completions[0].StartedOn != "0001-01-01" {
		t.Fatalf("first-year stats = %+v, %+v", got.Daily[0], got.Completions)
	}
}
