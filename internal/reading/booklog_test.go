package reading

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"pandalibrary/internal/stats"
)

func percent(value float64) *float64 { return &value }

func TestDeriveAttempts(t *testing.T) {
	finished := int64(5000)
	session := func(startedAt int64, start, end *float64) attemptSession {
		return attemptSession{
			StartedAt: startedAt, EndedAt: startedAt + 100, ActiveSeconds: 60, Source: "web", Start: start, End: end,
		}
	}
	tests := []struct {
		name       string
		sessions   []attemptSession
		finishedAt *int64
		restartAt  *int64
		numbers    []int
		statuses   []string
		maxima     []*float64
	}{
		{name: "no sessions", numbers: []int{}, statuses: []string{}, maxima: []*float64{}},
		{
			name:     "single attempt",
			sessions: []attemptSession{session(1000, percent(0.1), percent(0.3)), session(2000, percent(0.3), percent(0.5))},
			numbers:  []int{1, 1}, statuses: []string{attemptInProgress}, maxima: []*float64{percent(0.5)},
		},
		{
			name: "returning to beginning does not start a cycle",
			sessions: []attemptSession{
				session(1000, percent(0), percent(0.5)), session(2000, percent(0.5), percent(1)),
				session(3000, percent(0), percent(0.2)),
			},
			numbers:  []int{1, 1, 1},
			statuses: []string{attemptInProgress},
			maxima:   []*float64{percent(1)},
		},
		{
			name: "reading after finished_at stays in the same cycle",
			sessions: []attemptSession{
				session(1000, percent(0.2), percent(0.6)), session(6000, percent(0.5), percent(0.7)),
				session(7000, percent(0.7), percent(0.8)),
			},
			finishedAt: &finished,
			numbers:    []int{1, 1, 1},
			statuses:   []string{attemptCompleted},
			maxima:     []*float64{percent(0.8)},
		},
		{
			name: "null percentages",
			sessions: []attemptSession{
				session(1000, nil, nil), session(2000, nil, percent(0.97)), session(3000, nil, percent(0.05)),
				session(4000, nil, nil),
			},
			numbers:  []int{1, 1, 1, 1},
			statuses: []string{attemptInProgress},
			maxima:   []*float64{percent(0.97)},
		},
		{
			name: "backward jump is not a new attempt",
			sessions: []attemptSession{
				session(1000, percent(0.5), percent(0.54)), session(2000, percent(0.02), percent(0.3)),
				session(3000, percent(0.3), percent(0.96)),
			},
			numbers:  []int{1, 1, 1},
			statuses: []string{attemptInProgress},
			maxima:   []*float64{percent(0.96)},
		},
		{
			name: "explicit restart splits an unfinished attempt inclusively",
			sessions: []attemptSession{
				session(1000, percent(0.1), percent(0.4)),
				session(5000, percent(0.4), percent(0.5)),
				session(6000, percent(0.5), percent(0.6)),
			},
			restartAt: &finished,
			numbers:   []int{1, 2, 2}, statuses: []string{attemptStopped, attemptInProgress},
			maxima: []*float64{percent(0.4), percent(0.6)},
		},
		{
			name: "restart before first session does not split",
			sessions: []attemptSession{
				session(5000, nil, nil), session(6000, nil, percent(0.5)),
			},
			restartAt: &finished,
			numbers:   []int{1, 1}, statuses: []string{attemptInProgress},
			maxima: []*float64{percent(0.5)},
		},
		{
			name: "finished_at before the first session does not split",
			sessions: []attemptSession{
				session(6000, percent(0), percent(0.4)), session(7000, percent(0.4), percent(0.5)),
			},
			finishedAt: &finished,
			numbers:    []int{1, 1},
			statuses:   []string{attemptInProgress},
			maxima:     []*float64{percent(0.5)},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			attempts, numbers := deriveAttempts(test.sessions, test.finishedAt, test.restartAt)
			if !reflect.DeepEqual(numbers, test.numbers) {
				t.Fatalf("numbers = %v, want %v", numbers, test.numbers)
			}
			statuses := []string{}
			maxima := []*float64{}
			for index, attempt := range attempts {
				if attempt.Number != index+1 || !reflect.DeepEqual(attempt.Sources, []string{"web"}) {
					t.Errorf("attempt %d = %+v", index, attempt)
				}
				statuses = append(statuses, attempt.Status)
				maxima = append(maxima, attempt.MaxPercentage)
			}
			if !reflect.DeepEqual(statuses, test.statuses) || !reflect.DeepEqual(maxima, test.maxima) {
				t.Fatalf("statuses = %v maxima = %v, want %v %v", statuses, maxima, test.statuses, test.maxima)
			}
		})
	}

	attempts, _ := deriveAttempts([]attemptSession{
		{StartedAt: 1000, EndedAt: 9000, ActiveSeconds: 30, Source: "web"},
		{StartedAt: 2000, EndedAt: 3000, ActiveSeconds: 40, Source: "koreader"},
	}, nil, nil)
	if len(attempts) != 1 || attempts[0].Sessions != 2 || attempts[0].Seconds != 70 ||
		!attempts[0].StartedAt.Equal(time.UnixMilli(1000)) || !attempts[0].EndedAt.Equal(time.UnixMilli(9000)) ||
		!reflect.DeepEqual(attempts[0].Sources, []string{"koreader", "web"}) {
		t.Fatalf("aggregated attempt = %+v", attempts)
	}

	attempts, _ = deriveAttempts([]attemptSession{
		{StartedAt: 1000, EndedAt: 2000, ActiveSeconds: 30, Source: "web"},
		{StartedAt: 6000, EndedAt: 9000, ActiveSeconds: 40, Source: "web"},
	}, &finished, nil)
	if len(attempts) != 1 || attempts[0].Status != attemptCompleted || attempts[0].Sessions != 2 ||
		attempts[0].Seconds != 70 || !attempts[0].EndedAt.Equal(time.UnixMilli(finished)) {
		t.Fatalf("completed attempt end moved = %+v", attempts)
	}
}

func sessionUUID(n int) string {
	return fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", n)
}

func (f readingFixture) insertSession(
	t *testing.T, n int, user, book int64, source string, startedAt time.Time, seconds int64, start, end *float64,
) {
	t.Helper()
	ms := startedAt.UnixMilli()
	if _, err := f.db.Writer.ExecContext(context.Background(), `INSERT INTO reading_sessions
		(id, user_id, book_id, source, device, started_at, ended_at, active_seconds, start_percentage, end_percentage, created_at)
		VALUES (?, ?, ?, ?, 'Device', ?, ?, ?, ?, ?, 1)`,
		sessionUUID(n), user, book, source, ms, ms+seconds*1000, seconds, start, end); err != nil {
		t.Fatalf("insert session: %v", err)
	}
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestReadingSummaryTotalsRecordsAndTimezoneDays(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}

	empty, err := fixture.service.GetReadingSummary(ctx, reader, 101, "UTC")
	if err != nil || empty.Sessions != 0 || empty.TotalSeconds != 0 || empty.Attempts == nil ||
		len(empty.Attempts) != 0 || empty.Days == nil || len(empty.Days) != 0 ||
		empty.FirstReadAt != nil || empty.PacePercentPerHour != nil || empty.Records.LongestSession != nil {
		t.Fatalf("empty summary = %+v, %v", empty, err)
	}

	// 23:30 and 00:30 in Shanghai straddle local midnight but share one UTC date.
	fixture.insertSession(t, 1, 2, 101, "web", mustTime(t, "2026-05-20T15:30:00Z"), 600, percent(0), percent(0.1))
	fixture.insertSession(t, 2, 2, 101, "koreader", mustTime(t, "2026-05-20T16:30:00Z"), 1200, percent(0.1), percent(0.3))
	fixture.insertSession(t, 3, 2, 101, "web", mustTime(t, "2026-05-22T02:00:00Z"), 1800, percent(0.3), percent(0.2))
	fixture.insertSession(t, 4, 2, 101, "web", mustTime(t, "2026-05-25T02:00:00Z"), 0, nil, nil)
	fixture.insertSession(t, 5, 1, 101, "web", mustTime(t, "2026-05-20T10:00:00Z"), 9999, percent(0), percent(1))
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO reading_progress
		(user_id, book_id, source, percentage, updated_at, rev) VALUES (2, 101, 'web', 0.25, 1, 1)`); err != nil {
		t.Fatal(err)
	}

	local, err := fixture.service.GetReadingSummary(ctx, reader, 101, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if local.Progress != 0.25 || local.Sessions != 4 || local.TotalSeconds != 3600 || local.AverageSeconds != 900 ||
		local.ActiveDays != 3 || local.SpanDays != 3 ||
		!local.FirstReadAt.Equal(mustTime(t, "2026-05-20T15:30:00Z")) ||
		!local.LastReadAt.Equal(mustTime(t, "2026-05-25T02:00:00Z")) {
		t.Fatalf("local summary totals = %+v", local)
	}
	// (0.1 + 0.2 + 0) * 100 / 1 hour.
	if local.PacePercentPerHour == nil || fmt.Sprintf("%.6f", *local.PacePercentPerHour) != "30.000000" ||
		local.EstimatedSecondsLeft == nil || *local.EstimatedSecondsLeft != 9000 {
		t.Fatalf("pace = %v estimate = %v", local.PacePercentPerHour, local.EstimatedSecondsLeft)
	}
	wantDays := []ReadingDay{
		{Date: "2026-05-20", Seconds: 600, Sessions: 1, MaxPercentage: percent(0.1)},
		{Date: "2026-05-21", Seconds: 1200, Sessions: 1, MaxPercentage: percent(0.3)},
		{Date: "2026-05-22", Seconds: 1800, Sessions: 1, MaxPercentage: percent(0.3)},
	}
	if !reflect.DeepEqual(local.Days, wantDays) {
		t.Fatalf("local days = %+v", local.Days)
	}
	if local.Records.LongestSession == nil || *local.Records.LongestSession != (DayRecord{Seconds: 1800, Date: "2026-05-22"}) ||
		local.Records.BestDay == nil || *local.Records.BestDay != (DayRecord{Seconds: 1800, Date: "2026-05-22"}) ||
		local.Records.LongestStreakDays != 3 {
		t.Fatalf("local records = %+v", local.Records)
	}
	if len(local.Attempts) != 1 || local.Attempts[0].Status != attemptInProgress || local.Attempts[0].Sessions != 4 ||
		!reflect.DeepEqual(local.Attempts[0].Sources, []string{"koreader", "web"}) {
		t.Fatalf("local attempts = %+v", local.Attempts)
	}

	utc, err := fixture.service.GetReadingSummary(ctx, reader, 101, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if utc.ActiveDays != 2 || utc.SpanDays != 3 || utc.Records.LongestStreakDays != 1 ||
		len(utc.Days) != 2 || utc.Days[0] != (ReadingDay{Date: "2026-05-20", Seconds: 1800, Sessions: 2, MaxPercentage: utc.Days[0].MaxPercentage}) ||
		*utc.Records.BestDay != (DayRecord{Seconds: 1800, Date: "2026-05-20"}) {
		t.Fatalf("UTC summary = %+v", utc)
	}

	for _, bookID := range []int64{102, 103, 999} {
		if _, err := fixture.service.GetReadingSummary(ctx, reader, bookID, "UTC"); !errors.Is(err, ErrNotFound) {
			t.Errorf("summary for book %d = %v, want not found", bookID, err)
		}
	}
	for _, timezone := range []string{"", "Local", "Mars/Olympus", " UTC"} {
		if _, err := fixture.service.GetReadingSummary(ctx, reader, 101, timezone); !errors.Is(err, ErrInvalid) {
			t.Errorf("summary timezone %q = %v, want invalid", timezone, err)
		}
	}
}

func TestReadingSummaryDoesNotInventCycleAfterFinishedAt(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	fixture.insertSession(t, 1, 2, 101, "web", mustTime(t, "2026-01-01T10:00:00Z"), 60, percent(0), percent(0.5))
	fixture.insertSession(t, 2, 2, 101, "web", mustTime(t, "2026-03-01T10:00:00Z"), 60, percent(0.4), percent(0.6))
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO user_books
		(user_id, book_id, status, finished_at, updated_at, rev) VALUES (2, 101, 'reading', ?, 1, 1)`,
		mustTime(t, "2026-02-01T00:00:00Z").UnixMilli()); err != nil {
		t.Fatal(err)
	}
	summary, err := fixture.service.GetReadingSummary(ctx, Viewer{UserID: 2}, 101, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Attempts) != 1 || summary.Attempts[0].Number != 1 || summary.Attempts[0].Status != attemptInProgress {
		t.Fatalf("attempts = %+v", summary.Attempts)
	}
}

func TestReadingSummaryUsesPersistentCyclesWithoutSessions(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	start := mustTime(t, "2026-01-01T10:00:00Z")
	restart := start.AddDate(0, 1, 0)
	secondRestart := restart.AddDate(0, 1, 0)
	for _, cycle := range []struct {
		start, end time.Time
		status     string
		percentage float64
	}{
		{start, start.Add(time.Hour), "finished", 1},
		{restart, restart.Add(time.Hour), "abandoned", 0.4},
	} {
		if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO reading_cycles
			(user_id, book_id, started_at, ended_at, status, percentage) VALUES (2, 101, ?, ?, ?, ?)`,
			cycle.start.UnixMilli(), cycle.end.UnixMilli(), cycle.status, cycle.percentage); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO user_books
		(user_id, book_id, status, started_at, updated_at, rev) VALUES (2, 101, 'rereading', ?, ?, 1)`,
		secondRestart.UnixMilli(), secondRestart.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	reader := Viewer{UserID: 2}
	summary, err := fixture.service.GetReadingSummary(ctx, reader, 101, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Attempts) != 3 || summary.Sessions != 0 || summary.Progress != 0 ||
		summary.Attempts[0].Number != 3 || summary.Attempts[0].Status != attemptInProgress ||
		summary.Attempts[1].Outcome != "abandoned" || *summary.Attempts[1].MaxPercentage != 0.4 ||
		summary.Attempts[2].Outcome != "finished" {
		t.Fatalf("persistent summary without sessions = %+v", summary)
	}

	fixture.insertSession(t, 1, 2, 101, "web", start, 60, percent(0), percent(1))
	// Reading after abandonment still belongs to that cycle until explicit rereading.
	fixture.insertSession(t, 2, 2, 101, "web", restart.Add(2*time.Hour), 60, percent(0.4), percent(0.6))
	fixture.insertSession(t, 3, 2, 101, "web", secondRestart, 60, percent(0), percent(1))
	fixture.insertSession(t, 4, 2, 101, "web", secondRestart.Add(time.Hour), 60, percent(0), percent(0.1))
	summary, err = fixture.service.GetReadingSummary(ctx, reader, 101, "UTC")
	if err != nil || len(summary.Attempts) != 3 || summary.Attempts[0].Sessions != 2 ||
		summary.Attempts[1].Sessions != 1 || summary.Attempts[2].Sessions != 1 {
		t.Fatalf("persistent summary with sessions = %+v, %v", summary, err)
	}
	page, err := fixture.service.ListBookSessions(ctx, reader, 101, "all", "UTC", 25, "")
	if err != nil || len(page.Items) != 4 {
		t.Fatalf("cycle sessions = %+v, %v", page, err)
	}
	for index, want := range []int{3, 3, 2, 1} {
		if page.Items[index].Attempt != want {
			t.Fatalf("session %d cycle = %d, want %d", index, page.Items[index].Attempt, want)
		}
	}
}

func TestReadingSummaryPostCompletionSessionsKeepFinishDate(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	start := mustTime(t, "2026-01-01T10:00:00Z")
	finished := start.Add(26 * time.Hour)
	fixture.insertSession(t, 1, 2, 101, "web", start.Add(time.Hour), 3600, percent(0), percent(0.5))
	fixture.insertSession(t, 2, 2, 101, "web", start.Add(24*time.Hour), 3600, percent(0.5), percent(1))
	// Browsing after completion: counted as reading time but not as pace or a new attempt.
	fixture.insertSession(t, 3, 2, 101, "web", finished.Add(24*time.Hour), 1800, percent(0.2), percent(0.6))
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO user_books
		(user_id, book_id, status, started_at, finished_at, updated_at, rev) VALUES (2, 101, 'finished', ?, ?, ?, 1)`,
		start.UnixMilli(), finished.UnixMilli(), finished.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	summary, err := fixture.service.GetReadingSummary(ctx, Viewer{UserID: 2}, 101, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Attempts) != 1 {
		t.Fatalf("attempts = %+v", summary.Attempts)
	}
	attempt := summary.Attempts[0]
	if attempt.Status != attemptCompleted || attempt.Outcome != "finished" || !attempt.EndedAt.Equal(finished) ||
		attempt.Sessions != 3 || attempt.Seconds != 9000 {
		t.Fatalf("completed attempt = %+v", attempt)
	}
	// 100% over 2 hours; the post-completion session is excluded.
	if summary.Progress != 1 || summary.TotalSeconds != 9000 || summary.Sessions != 3 ||
		summary.PacePercentPerHour == nil || fmt.Sprintf("%.6f", *summary.PacePercentPerHour) != "50.000000" ||
		summary.EstimatedSecondsLeft != nil {
		t.Fatalf("summary = %+v pace = %v", summary, summary.PacePercentPerHour)
	}
}

func TestReadingSummaryArchivedCompletedCycleKeepsEndDate(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	start := mustTime(t, "2026-01-01T10:00:00Z")
	ended := start.Add(time.Hour)
	restart := start.AddDate(0, 0, 10)
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO reading_cycles
		(user_id, book_id, started_at, ended_at, status, percentage) VALUES (2, 101, ?, ?, 'finished', 1)`,
		start.UnixMilli(), ended.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO user_books
		(user_id, book_id, status, started_at, updated_at, rev) VALUES (2, 101, 'rereading', ?, ?, 1)`,
		restart.UnixMilli(), restart.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	fixture.insertSession(t, 1, 2, 101, "web", start, 3600, percent(0), percent(1))
	fixture.insertSession(t, 2, 2, 101, "web", start.AddDate(0, 0, 2), 600, percent(0.1), percent(0.9))
	fixture.insertSession(t, 3, 2, 101, "web", restart.Add(time.Hour), 3600, percent(0), percent(0.2))
	summary, err := fixture.service.GetReadingSummary(ctx, Viewer{UserID: 2}, 101, "UTC")
	if err != nil || len(summary.Attempts) != 2 {
		t.Fatalf("summary = %+v, %v", summary, err)
	}
	archived := summary.Attempts[1]
	if archived.Status != attemptCompleted || archived.Sessions != 2 || archived.Seconds != 4200 ||
		!archived.EndedAt.Equal(ended) {
		t.Fatalf("archived attempt = %+v", archived)
	}
	// (100% + 20%) over 2 hours; the post-completion session is excluded.
	if summary.TotalSeconds != 7800 || summary.PacePercentPerHour == nil ||
		fmt.Sprintf("%.6f", *summary.PacePercentPerHour) != "60.000000" || summary.EstimatedSecondsLeft == nil {
		t.Fatalf("summary = %+v pace = %v", summary, summary.PacePercentPerHour)
	}
}

func TestReadingSummaryShowsManualTerminalCycleWithoutSessions(t *testing.T) {
	for _, status := range []string{"finished", "skimmed", "abandoned"} {
		t.Run(status, func(t *testing.T) {
			fixture := newReadingFixture(t)
			ctx := context.Background()
			if _, err := fixture.db.Writer.ExecContext(ctx, `INSERT INTO user_books
				(user_id, book_id, status, started_at, finished_at, updated_at, rev)
				VALUES (2, 101, ?, 1000, 2000, 2000, 1)`, status); err != nil {
				t.Fatal(err)
			}
			summary, err := fixture.service.GetReadingSummary(ctx, Viewer{UserID: 2}, 101, "UTC")
			if err != nil || len(summary.Attempts) != 1 || summary.Attempts[0].Outcome != status ||
				summary.Attempts[0].Number != 1 || summary.Attempts[0].Sessions != 0 {
				t.Fatalf("manual terminal cycle = %+v, %v", summary, err)
			}
		})
	}
}

func TestListBookSessionsPagesRangesAndCursors(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}
	fixture.service.now = func() time.Time { return mustTime(t, "2026-11-07T03:00:00Z") }
	base := mustTime(t, "2026-01-01T12:00:00Z")
	for n := 1; n <= 30; n++ {
		start, end := percent(float64(n-1)/30), percent(float64(n)/30)
		if n == 30 {
			start, end = percent(0), percent(0.05)
		}
		fixture.insertSession(t, n, 2, 101, "web", base.AddDate(0, 0, (n-1)*10), 60, start, end)
	}
	// Equal start times are ordered by insertion sequence.
	fixture.insertSession(t, 31, 2, 101, "web", base.AddDate(0, 0, 290), 60, nil, nil)
	fixture.insertSession(t, 32, 1, 101, "web", base, 60, nil, nil)

	seen := map[string]bool{}
	var cursor string
	var pages int
	for {
		page, err := fixture.service.ListBookSessions(ctx, reader, 101, "", "UTC", 7, cursor)
		if err != nil {
			t.Fatal(err)
		}
		pages++
		if page.Total != 31 {
			t.Fatalf("total = %d", page.Total)
		}
		for _, item := range page.Items {
			if seen[item.ID] {
				t.Fatalf("duplicate session %s", item.ID)
			}
			seen[item.ID] = true
		}
		if pages == 1 {
			if page.Items[0].ID != sessionUUID(31) || page.Items[1].ID != sessionUUID(30) ||
				page.Items[0].Attempt != 1 || page.Items[1].Attempt != 1 || page.Items[2].Attempt != 1 ||
				page.Items[0].Change != nil || page.Items[1].Change == nil {
				t.Fatalf("first page = %+v", page.Items[:3])
			}
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
		if _, err := fixture.service.ListBookSessions(ctx, reader, 101, "30d", "UTC", 7, cursor); !errors.Is(err, ErrInvalid) {
			t.Fatalf("range-mismatched cursor = %v", err)
		}
		if _, err := fixture.service.ListBookSessions(ctx, reader, 101, "all", "Asia/Shanghai", 7, cursor); !errors.Is(err, ErrInvalid) {
			t.Fatalf("timezone-mismatched cursor = %v", err)
		}
		if _, err := fixture.service.ListBookSessions(ctx, Viewer{UserID: 1, IsAdmin: true}, 101, "all", "UTC", 7, cursor); !errors.Is(err, ErrInvalid) {
			t.Fatalf("viewer-mismatched cursor = %v", err)
		}
	}
	if len(seen) != 31 || pages != 5 {
		t.Fatalf("paged %d sessions in %d pages", len(seen), pages)
	}

	// Sessions start every 10 days from 2026-01-01; the last two start on 2026-10-18.
	// 30d starts 2026-10-09 and 90d starts 2026-08-10.
	for rangeName, want := range map[string]int64{"30d": 2, "90d": 8, "year": 31, "all": 31} {
		page, err := fixture.service.ListBookSessions(ctx, reader, 101, rangeName, "UTC", 100, "")
		if err != nil || page.Total != want || int64(len(page.Items)) != want {
			t.Errorf("range %s = %d/%d, %v, want %d", rangeName, page.Total, len(page.Items), err, want)
		}
	}
	for _, args := range []struct {
		rangeName, timezone, cursor string
		limit                       int
	}{
		{"week", "UTC", "", 10}, {"all", "Nope/Zone", "", 10}, {"all", "UTC", "", 101},
		{"all", "UTC", "", -1}, {"all", "UTC", "not-a-cursor", 10},
	} {
		if _, err := fixture.service.ListBookSessions(ctx, reader, 101, args.rangeName, args.timezone, args.limit, args.cursor); !errors.Is(err, ErrInvalid) {
			t.Errorf("invalid list %+v = %v", args, err)
		}
	}
	if _, err := fixture.service.ListBookSessions(ctx, reader, 102, "all", "UTC", 10, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("hidden book sessions = %v", err)
	}
}

func TestRangeStartUsesLocalCalendar(t *testing.T) {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	// 2026-01-01T17:00Z is already 2026-01-02 in Shanghai.
	now := mustTime(t, "2026-01-01T17:00:00Z")
	since, ok, err := rangeStart(SessionRangeYear, now, location)
	if err != nil || !ok || since != mustTime(t, "2025-12-31T16:00:00Z").UnixMilli() {
		t.Fatalf("year start = %d %v %v", since, ok, err)
	}
	since, _, _ = rangeStart(SessionRange30Days, now, location)
	if since != mustTime(t, "2025-12-03T16:00:00Z").UnixMilli() {
		t.Fatalf("30d start = %s", time.UnixMilli(since).UTC())
	}
}

func TestDeleteBookSessionIsOwnerOnlyAndUpdatesStats(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	reader := Viewer{UserID: 2}
	day := mustTime(t, "2026-05-20T10:00:00Z")
	fixture.insertSession(t, 1, 2, 101, "web", day, 600, nil, nil)
	fixture.insertSession(t, 2, 2, 101, "web", day.Add(time.Hour), 300, nil, nil)
	fixture.insertSession(t, 3, 1, 101, "web", day, 900, nil, nil)
	statsService, err := stats.NewService(fixture.db.Reader)
	if err != nil {
		t.Fatal(err)
	}
	statsSeconds := func() int64 {
		response, err := statsService.Get(ctx, stats.Viewer{UserID: 2}, "2026-05-20", "2026-05-20", "UTC")
		if err != nil {
			t.Fatal(err)
		}
		return response.Daily[0].ActiveSeconds
	}
	if got := statsSeconds(); got != 900 {
		t.Fatalf("stats before delete = %d", got)
	}
	var revBefore int64
	if err := fixture.db.Reader.QueryRowContext(ctx, `SELECT value FROM sync_counter WHERE id = 1`).Scan(&revBefore); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		viewer  Viewer
		bookID  int64
		session string
		want    error
	}{
		{reader, 101, sessionUUID(3), ErrNotFound},  // another user's session
		{reader, 101, sessionUUID(99), ErrNotFound}, // missing
		{reader, 102, sessionUUID(1), ErrNotFound},  // invisible book
		{Viewer{UserID: 1, IsAdmin: true}, 101, sessionUUID(1), ErrNotFound},
		{reader, 101, "not-a-uuid", ErrInvalid},
	}
	for _, test := range cases {
		if err := fixture.service.DeleteBookSession(ctx, test.viewer, test.bookID, test.session); !errors.Is(err, test.want) {
			t.Errorf("delete %+v = %v", test, err)
		}
	}
	if err := fixture.service.DeleteBookSession(ctx, reader, 101, sessionUUID(1)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.service.DeleteBookSession(ctx, reader, 101, sessionUUID(1)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("repeated delete = %v", err)
	}
	if got := statsSeconds(); got != 300 {
		t.Fatalf("stats after delete = %d", got)
	}
	var revAfter int64
	if err := fixture.db.Reader.QueryRowContext(ctx, `SELECT value FROM sync_counter WHERE id = 1`).Scan(&revAfter); err != nil {
		t.Fatal(err)
	}
	if revAfter != revBefore {
		t.Fatalf("delete bumped sync revision %d -> %d", revBefore, revAfter)
	}
	page, err := fixture.service.ListBookSessions(ctx, reader, 101, "all", "UTC", 10, "")
	if err != nil || page.Total != 1 || page.Items[0].ID != sessionUUID(2) {
		t.Fatalf("sessions after delete = %+v, %v", page, err)
	}
}
