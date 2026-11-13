package stats

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestHistoryLocalDays(t *testing.T) {
	for _, test := range []struct {
		name, zone string
		instants   []string
		dates      []string
		counts     []int64
	}{
		{"year boundary", "Asia/Shanghai",
			[]string{"2025-12-31T15:59:59Z", "2025-12-31T16:00:00Z", "2026-12-31T15:59:59Z", "2026-12-31T16:00:00Z"},
			[]string{"2026-12-31", "2026-01-01"}, []int64{1, 1}},
		{"fall DST repeated hour", "America/New_York",
			[]string{"2026-11-01T03:59:59Z", "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-02T05:00:00Z"},
			[]string{"2026-11-02", "2026-11-01", "2026-10-31"}, []int64{1, 3, 1}},
		{"spring DST", "America/New_York",
			[]string{"2026-03-08T04:59:59Z", "2026-03-08T05:00:00Z", "2026-03-09T03:59:59Z", "2026-03-09T04:00:00Z"},
			[]string{"2026-03-09", "2026-03-08", "2026-03-07"}, []int64{1, 2, 1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newStatsFixture(t)
			for _, at := range test.instants {
				// Crossing midnight does not split a session.
				f.session(t, 2, 101, instant(t, at), 120)
			}
			got, err := f.service.History(context.Background(), Viewer{UserID: 2}, 2026, test.zone, 100, "")
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Items) != len(test.dates) {
				t.Fatalf("items = %+v", got.Items)
			}
			var total int64
			for i, row := range got.Items {
				if row.Date != test.dates[i] || row.SessionCount != test.counts[i] ||
					row.ActiveSeconds != test.counts[i]*120 || row.DaySessionCount != row.SessionCount ||
					row.DayActiveSeconds != row.ActiveSeconds || row.Cycle != 1 {
					t.Fatalf("row %d = %+v", i, row)
				}
				total += row.SessionCount
			}
			if got.Summary.SessionCount != total || got.Summary.ActiveDays != int64(len(test.dates)) {
				t.Fatalf("summary = %+v", got.Summary)
			}
		})
	}
}

func TestHistoryCyclesPaginationAndFullSummary(t *testing.T) {
	f := newStatsFixture(t)
	at := instant(t, "2026-06-02T10:00:00Z")
	f.exec(t, `INSERT INTO user_books (user_id, book_id, status, started_at, reading_cycle, updated_at, rev)
		VALUES (2, 101, 'finished', ?, 3, ?, 1)`, at+60000, at+90000)
	// Starts, not a finished status or page navigation, establish an actual reread.
	f.exec(t, `INSERT INTO reading_cycles (user_id, book_id, started_at, ended_at, status, percentage)
		VALUES (2, 101, ?, ?, 'finished', 1), (2, 101, ?, ?, 'abandoned', 0.5)`,
		at-60000, at, at+30000, at+40000)
	for _, offset := range []int64{-1, 0, 1000, 30000, 40000, 50000, 60000, 100000} {
		f.session(t, 2, 101, at+offset, 10)
	}
	f.session(t, 2, 104, at, 40)
	f.session(t, 2, 104, instant(t, "2026-01-01T01:00:00Z"), 0)
	f.session(t, 2, 104, instant(t, "2026-01-02T01:00:00Z"), 20)
	f.exec(t, `UPDATE books SET cover_sha256 = ? WHERE id = 101`, strings.Repeat("a", 64))
	viewer := Viewer{UserID: 2}
	full, err := f.service.History(context.Background(), viewer, 2026, "UTC", 100, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Items) != 6 || full.NextCursor != nil {
		t.Fatalf("full = %+v", full)
	}
	for i, count := range []int64{2, 3, 3} {
		row := full.Items[i]
		if row.Date != "2026-06-02" || row.BookID != 101 || row.Cycle != int64(3-i) ||
			row.SessionCount != count || row.DaySessionCount != 9 || row.DayActiveSeconds != 120 ||
			!reflect.DeepEqual(row.Authors, []string{"First", "Later"}) ||
			row.CoverURL == nil || *row.CoverURL != "/api/v1/books/101/cover" {
			t.Fatalf("cycle row %d = %+v", i, row)
		}
	}
	if full.Items[3].BookID != 104 || full.Items[3].Cycle != 1 ||
		full.Items[3].CoverURL != nil || len(full.Items[3].Authors) != 0 {
		t.Fatalf("second book = %+v", full.Items[3])
	}
	summary := full.Summary
	if summary.Books != 2 || summary.ActiveSeconds != 140 || summary.SessionCount != 11 ||
		summary.ActiveDays != 2 || len(summary.Months) != 12 ||
		summary.Months[0] != (HistoryMonth{Month: "2026-01", Books: 1, ActiveSeconds: 20, SessionCount: 2}) ||
		summary.Months[5] != (HistoryMonth{Month: "2026-06", Books: 2, ActiveSeconds: 120, SessionCount: 9}) ||
		summary.Records.BusiestDay == nil || *summary.Records.BusiestDay != (Day{Date: "2026-06-02", ActiveSeconds: 120, SessionCount: 9}) ||
		summary.Records.LongestSessionSeconds != 40 || summary.Records.MostReadBook == nil ||
		*summary.Records.MostReadBook != (HistoryMostReadBook{BookID: 101, Title: "Visible", SessionCount: 8}) {
		t.Fatalf("summary = %+v", summary)
	}
	for i, month := range summary.Months {
		if month.Month != fmt.Sprintf("2026-%02d", i+1) {
			t.Fatalf("month %d = %+v", i, month)
		}
	}
	// Every possible page size must traverse all ties without loss or duplication.
	for _, limit := range []int{1, 2, 3, 4, 6} {
		var rows []HistoryRow
		cursor := ""
		for page := 0; ; page++ {
			if page > len(full.Items) {
				t.Fatal("pagination did not terminate")
			}
			got, err := f.service.History(context.Background(), viewer, 2026, "UTC", limit, cursor)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Items) > limit || !reflect.DeepEqual(got.Summary, summary) {
				t.Fatalf("limit %d: page = %+v", limit, got)
			}
			rows = append(rows, got.Items...)
			if got.NextCursor == nil {
				break
			}
			cursor = *got.NextCursor
		}
		if !reflect.DeepEqual(rows, full.Items) {
			t.Fatalf("limit %d: rows = %+v, want %+v", limit, rows, full.Items)
		}
	}
}

func TestHistoryLegacyCyclesAndMissingState(t *testing.T) {
	f := newStatsFixture(t)
	at := instant(t, "2026-05-01T00:00:00Z")
	f.exec(t, `INSERT INTO user_books (user_id, book_id, status, reading_cycle, started_at, updated_at, rev)
		VALUES (2, 101, 'rereading', 2, ?, 1, 1)`, at)
	f.session(t, 2, 101, at-1, 1)
	f.session(t, 2, 101, at, 2)
	f.session(t, 2, 104, at, 3)
	f.archive(t, 2, 104, at, "finished")
	// Missing user_books is legal; archives still identify the current cycle.
	f.session(t, 2, 104, at+1, 4)
	got, err := f.service.History(context.Background(), Viewer{UserID: 2}, 2026, "UTC", 100, "")
	if err != nil {
		t.Fatal(err)
	}
	type key struct{ book, cycle, count int64 }
	var keys []key
	for _, row := range got.Items {
		keys = append(keys, key{row.BookID, row.Cycle, row.SessionCount})
	}
	if !reflect.DeepEqual(keys, []key{{104, 2, 1}, {101, 2, 1}, {104, 1, 1}, {101, 1, 1}}) {
		t.Fatalf("cycles = %+v", keys)
	}
}

func TestHistoryLatestSessionOrderAndTiedPagination(t *testing.T) {
	f := newStatsFixture(t)
	at := instant(t, "2026-07-01T10:00:00Z")
	f.exec(t, `UPDATE books SET visibility = 'public' WHERE id = 103`)
	for _, entry := range []struct{ book, offset, active int64 }{
		{101, 1000, 10}, {104, -1000, 10}, {104, 1000, 10}, {103, 2000, 20},
	} {
		f.session(t, 2, entry.book, at+entry.offset, entry.active)
	}
	var books []int64
	cursor := ""
	for page := 0; page < 3; page++ {
		got, err := f.service.History(context.Background(), Viewer{UserID: 2}, 2026, "UTC", 1, cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Items) != 1 || got.Items[0].DaySessionCount != 4 ||
			got.Items[0].DayActiveSeconds != 50 || got.Summary.SessionCount != 4 {
			t.Fatalf("page %d = %+v", page, got)
		}
		books = append(books, got.Items[0].BookID)
		if page < 2 {
			if got.NextCursor == nil {
				t.Fatal("missing next cursor")
			}
			cursor = *got.NextCursor
		} else if got.NextCursor != nil {
			t.Fatal("unexpected next cursor")
		}
	}
	if !reflect.DeepEqual(books, []int64{103, 101, 104}) {
		t.Fatalf("book order = %v", books)
	}
}

func TestHistoryMoreThanOneMaximumPage(t *testing.T) {
	f := newStatsFixture(t)
	start := instant(t, "2026-01-01T12:00:00Z")
	f.exec(t, `WITH RECURSIVE n(i) AS (
		SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 149
	)
	INSERT INTO reading_sessions
		(id, user_id, book_id, source, started_at, ended_at, active_seconds, created_at)
	SELECT printf('00000000-0000-7000-8000-%012d', i + 1), 2,
		CASE WHEN i % 2 = 0 THEN 101 ELSE 104 END, 'web',
		? + i * 86400000, ? + i * 86400000 + 1000, 1, 1 FROM n`, start, start)
	first, err := f.service.History(context.Background(), Viewer{UserID: 2}, 2026, "UTC", 100, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 100 || first.NextCursor == nil || first.Summary.SessionCount != 150 ||
		first.Summary.ActiveSeconds != 150 || first.Summary.ActiveDays != 150 ||
		first.Summary.Books != 2 || first.Summary.Months[0].SessionCount != 31 ||
		first.Summary.Months[4].SessionCount != 30 {
		t.Fatalf("first page = %+v", first)
	}
	second, err := f.service.History(context.Background(), Viewer{UserID: 2}, 2026, "UTC", 100, *first.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Items) != 50 || second.NextCursor != nil ||
		!reflect.DeepEqual(first.Summary, second.Summary) ||
		first.Items[99].Date <= second.Items[0].Date || second.Items[49].Date != "2026-01-01" {
		t.Fatalf("second page = %+v", second)
	}
}

func TestHistoryVisibilityAndViewerScope(t *testing.T) {
	f := newStatsFixture(t)
	at := instant(t, "2026-01-01T00:00:00Z")
	f.exec(t, `INSERT INTO books (id, library_id, title, sort_title, visibility, owner_id, created_at, updated_at) VALUES
		(105, 20, 'Public', 'public', 'public', NULL, 1, 1),
		(106, 20, 'Owned', 'owned', 'private', 2, 1, 1),
		(107, 10, 'Other private', 'other', 'private', 3, 1, 1)`)
	for _, user := range []int64{1, 2, 4} {
		for _, book := range []int64{101, 102, 103, 104, 105, 106, 107} {
			f.session(t, user, book, at, book)
		}
	}
	for _, test := range []struct {
		viewer Viewer
		books  []int64
	}{
		{Viewer{UserID: 1, IsAdmin: true}, []int64{101, 103, 104, 105}},
		{Viewer{UserID: 2}, []int64{101, 104, 105, 106}},
		{Viewer{UserID: 4}, []int64{105}},
	} {
		got, err := f.service.History(context.Background(), test.viewer, 2026, "UTC", 1, "")
		if err != nil {
			t.Fatal(err)
		}
		var seconds int64
		for _, id := range test.books {
			seconds += id
		}
		if got.Items[0].BookID != test.books[0] || got.Summary.Books != int64(len(test.books)) ||
			got.Summary.SessionCount != int64(len(test.books)) || got.Summary.ActiveSeconds != seconds ||
			got.Items[0].DayActiveSeconds != seconds || got.Summary.Months[0].Books != int64(len(test.books)) {
			t.Fatalf("viewer %+v: %+v", test.viewer, got)
		}
	}
}

func TestHistoryValidationEmptyAndCursorBinding(t *testing.T) {
	f := newStatsFixture(t)
	viewer := Viewer{UserID: 2}
	for _, year := range []int{1, 2024, 9998} {
		got, err := f.service.History(context.Background(), viewer, year, "UTC", 1, "")
		if err != nil || got.Items == nil || len(got.Items) != 0 || got.NextCursor != nil ||
			len(got.Summary.Months) != 12 || got.Summary.Records.BusiestDay != nil ||
			got.Summary.Records.MostReadBook != nil || got.Summary.SessionCount != 0 {
			t.Fatalf("empty year %d = %+v, %v", year, got, err)
		}
	}
	encode := func(c historyCursor) string {
		data, err := json.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(data)
	}
	valid := historyCursor{Version: 1, Year: 2026, Timezone: "UTC", UserID: 2, Date: "2026-01-01", BookID: 101, Cycle: 1, Latest: instant(t, "2026-01-01T00:00:00Z")}
	for _, test := range []struct {
		viewer Viewer
		year   int
		zone   string
		limit  int
		cursor string
	}{
		{viewer, 0, "UTC", 50, ""}, {viewer, 9999, "UTC", 50, ""},
		{viewer, 2026, "UTC", 0, ""}, {viewer, 2026, "UTC", 101, ""},
		{Viewer{}, 2026, "UTC", 50, ""}, {viewer, 2026, "", 50, ""},
		{viewer, 2026, "Local", 50, ""}, {viewer, 2026, "../UTC", 50, ""},
		{viewer, 2026, "Unknown/Zone", 50, ""}, {viewer, 2026, " UTC", 50, ""},
		{viewer, 2026, "UTC", 50, "not a cursor"}, {viewer, 2026, "UTC", 50, strings.Repeat("a", 2049)},
		{viewer, 2025, "UTC", 50, encode(valid)}, {viewer, 2026, "Asia/Shanghai", 50, encode(valid)},
		{Viewer{UserID: 3}, 2026, "UTC", 50, encode(valid)},
		{Viewer{UserID: 2, IsAdmin: true}, 2026, "UTC", 50, encode(valid)},
	} {
		if _, err := f.service.History(context.Background(), test.viewer, test.year, test.zone, test.limit, test.cursor); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%+v: error = %v", test, err)
		}
	}
	for _, mutate := range []func(*historyCursor){
		func(c *historyCursor) { c.Version = 2 }, func(c *historyCursor) { c.BookID = 0 },
		func(c *historyCursor) { c.Cycle = 0 }, func(c *historyCursor) { c.Date = "2026-02-30" },
		func(c *historyCursor) { c.Date = "2025-01-01" },
		func(c *historyCursor) { c.Latest-- },
	} {
		bad := valid
		mutate(&bad)
		if _, err := f.service.History(context.Background(), viewer, 2026, "UTC", 50, encode(bad)); !errors.Is(err, ErrInvalid) {
			t.Fatalf("cursor %+v: error = %v", bad, err)
		}
	}
	for _, raw := range []string{`{}`, `null`, `{"v":1} {}`, `{"unknown":1}`} {
		if _, err := f.service.History(context.Background(), viewer, 2026, "UTC", 50,
			base64.RawURLEncoding.EncodeToString([]byte(raw))); !errors.Is(err, ErrInvalid) {
			t.Fatalf("cursor %q: error = %v", raw, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.service.History(ctx, viewer, 2026, "UTC", 1, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request: %v", err)
	}
}
