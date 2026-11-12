package reading

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestAutoStatus(t *testing.T) {
	for _, current := range []string{"", "unread", "want_to_read", "reading", "rereading", "on_hold", "skimmed", "abandoned", "finished"} {
		for _, p := range []float64{0, 0.001, 0.5, 0.989, 0.99, 1} {
			t.Run(fmt.Sprintf("%s/%g", current, p), func(t *testing.T) {
				expected := current
				if current == "" {
					expected = "unread"
				}
				switch current {
				case "", "unread", "want_to_read":
					if p > 0 {
						expected = "reading"
					}
					if p >= 0.99 {
						expected = "finished"
					}
				case "reading", "rereading":
					if p >= 0.99 {
						expected = "finished"
					}
				case "on_hold":
					if p > 0 {
						expected = "reading"
					}
					if p >= 0.99 {
						expected = "finished"
					}
				}
				next, changed := autoStatus(current, current != "", p)
				if next != expected || changed != (expected != current && p > 0) {
					t.Fatalf("autoStatus = %s, %v; want %s", next, changed, expected)
				}
			})
		}
	}
}

func (f readingFixture) pushLifecycle(t *testing.T, item Mutation, want string) {
	t.Helper()
	response, err := f.service.Push(context.Background(), Viewer{UserID: 2}, PushRequest{Mutations: []Mutation{item}})
	if err != nil || len(response.Results) != 1 || response.Results[0].Status != want {
		t.Fatalf("push = %+v, %v; want one %s result", response, err, want)
	}
}

func (f readingFixture) lifecycleState(t *testing.T) BookState {
	t.Helper()
	state, err := f.service.GetBookState(context.Background(), Viewer{UserID: 2}, 101)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func progressMutation(p float64, updatedAt int64) Mutation {
	return mutation("reading_progress", "", "101", "upsert",
		fmt.Sprintf(`{"book_id":101,"book_file_id":201,"source":"web","percentage":%g,"locator":{"cfi":"a"},"device":"Web","device_id":"device"}`, p), updatedAt)
}

func TestProgressStatusLifecycleAndPull(t *testing.T) {
	f := newReadingFixture(t)
	f.pushLifecycle(t, progressMutation(0, 100), "applied")
	if f.lifecycleState(t).UserBook != nil {
		t.Fatal("zero progress created a status")
	}
	f.pushLifecycle(t, progressMutation(0.07, 200), "applied")
	state := f.lifecycleState(t)
	if state.UserBook == nil || state.UserBook.Status != "reading" || state.UserBook.StartedAt == nil ||
		state.UserBook.StartedAt.UnixMilli() != 2000 || state.UserBook.FinishedAt != nil {
		t.Fatalf("first progress status = %+v", state.UserBook)
	}
	cursor, err := f.service.Pull(context.Background(), Viewer{UserID: 2}, 0)
	if err != nil || len(cursor.UserBooks) != 1 {
		t.Fatalf("initial pull = %+v, %v", cursor, err)
	}
	f.service.now = func() time.Time { return time.UnixMilli(3000) }
	f.pushLifecycle(t, progressMutation(0.995, 300), "applied")
	state = f.lifecycleState(t)
	if state.UserBook.Status != "finished" || state.UserBook.FinishedAt == nil ||
		state.UserBook.FinishedAt.UnixMilli() != 3000 || state.UserBook.StartedAt.UnixMilli() != 2000 {
		t.Fatalf("completion status = %+v", state.UserBook)
	}
	if state.Progress.Percentage != 1 || string(state.Progress.Locator) != `{"cfi":"a"}` {
		t.Fatalf("completion did not normalize percentage and preserve locator: %+v", state.Progress)
	}
	pulled, err := f.service.Pull(context.Background(), Viewer{UserID: 2}, cursor.Cursor)
	if err != nil || len(pulled.UserBooks) != 1 || pulled.UserBooks[0].Status != "finished" ||
		pulled.UserBooks[0].Rev <= cursor.Cursor {
		t.Fatalf("derived status pull = %+v, %v", pulled, err)
	}
	f.service.now = func() time.Time { return time.UnixMilli(4000) }
	f.pushLifecycle(t, progressMutation(0.4, 3500), "applied")
	state = f.lifecycleState(t)
	if state.UserBook.Status != "finished" || state.Progress.Percentage != 1 ||
		state.Progress.UpdatedAt.UnixMilli() != 3500 {
		t.Fatalf("finished book did not keep complete progress while moving: %+v", state)
	}
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"finished","rating":9}`, 3800), "applied")
	if f.lifecycleState(t).Progress.Percentage != 1 {
		t.Fatal("rating-only update changed terminal reading position")
	}
}

func TestProgressPreservesManualStatusAndLWW(t *testing.T) {
	for _, status := range []string{"on_hold", "skimmed", "abandoned", "finished", "unread", "want_to_read"} {
		t.Run(status, func(t *testing.T) {
			f := newReadingFixture(t)
			if status == "on_hold" {
				f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
					`{"book_id":101,"status":"reading","started_at":50}`, 500), "applied")
			}
			f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
				fmt.Sprintf(`{"book_id":101,"status":%q,"rating":8,"started_at":50}`, status), 1000), "applied")
			f.service.now = func() time.Time { return time.UnixMilli(3000) }
			f.pushLifecycle(t, progressMutation(0.995, 2500), "applied")
			state := f.lifecycleState(t)
			want := status
			if status == "unread" || status == "want_to_read" || status == "on_hold" {
				want = "finished"
			}
			if state.UserBook.Status != want || state.UserBook.Rating == nil || *state.UserBook.Rating != 8 {
				t.Fatalf("status after progress = %+v", state.UserBook)
			}
		})
	}
	for _, clock := range []int64{2000, 3000} {
		t.Run(fmt.Sprint(clock), func(t *testing.T) {
			f := newReadingFixture(t)
			if _, err := f.db.Writer.Exec(`INSERT INTO user_books (user_id,book_id,status,updated_at,rev)
				VALUES (2,101,'unread',?,0)`, clock); err != nil {
				t.Fatal(err)
			}
			f.pushLifecycle(t, progressMutation(1, 1500), "applied")
			if f.lifecycleState(t).UserBook.Status != "unread" {
				t.Fatal("overwrote a tied/newer client status")
			}
		})
	}
	f := newReadingFixture(t)
	f.pushLifecycle(t, progressMutation(0, 1500), "applied")
	before := f.lifecycleState(t)
	f.pushLifecycle(t, progressMutation(1, 1000), "stale")
	if !reflect.DeepEqual(before, f.lifecycleState(t)) {
		t.Fatal("stale progress changed state")
	}
}

func TestReadBooksKeepCompleteProgressWhileSavingPosition(t *testing.T) {
	for _, status := range []string{"finished", "skimmed", "abandoned"} {
		t.Run(status, func(t *testing.T) {
			f := newReadingFixture(t)
			f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
				fmt.Sprintf(`{"book_id":101,"status":%q,"started_at":500,"finished_at":1000}`, status), 1000), "applied")
			before := f.lifecycleState(t)
			f.service.now = func() time.Time { return time.UnixMilli(3000) }
			f.pushLifecycle(t, mutation("reading_progress", "", "101", "upsert",
				`{"book_id":101,"book_file_id":201,"source":"koreader","percentage":0.3,"locator":{"cfi":"b"},"device":"Kobo","device_id":"kobo"}`,
				2500), "applied")
			state := f.lifecycleState(t)
			want := 0.3
			if status != "abandoned" {
				want = 1
			}
			if state.Progress == nil || state.Progress.Percentage != want ||
				string(state.Progress.Locator) != `{"cfi":"b"}` || state.Progress.Source != "koreader" ||
				state.Progress.Device != "Kobo" || state.Progress.DeviceID != "kobo" ||
				state.Progress.BookFileID == nil || *state.Progress.BookFileID != 201 ||
				state.Progress.UpdatedAt.UnixMilli() != 2500 {
				t.Fatalf("progress after scrolling = %+v", state.Progress)
			}
			if state.UserBook.Status != status || state.UserBook.ReadingCycle != before.UserBook.ReadingCycle ||
				!reflect.DeepEqual(state.UserBook.FinishedAt, before.UserBook.FinishedAt) ||
				state.UserBook.Rev != before.UserBook.Rev {
				t.Fatalf("user book changed: %+v -> %+v", before.UserBook, state.UserBook)
			}
			var cycles int
			if err := f.db.Reader.QueryRow(`SELECT count(*) FROM reading_cycles`).Scan(&cycles); err != nil || cycles != 0 {
				t.Fatalf("scrolling archived a cycle: %d, %v", cycles, err)
			}

			sessionID := "018f0f7e-7b00-7000-8000-0000000000a1"
			f.pushLifecycle(t, mutation("reading_sessions", sessionID, "", "upsert",
				`{"book_id":101,"source":"koreader","started_at":2600,"ended_at":2900,"active_seconds":120,"start_percentage":0.3,"end_percentage":0.35}`,
				2900), "applied")
			var start, end float64
			if err := f.db.Reader.QueryRow(`SELECT start_percentage,end_percentage FROM reading_sessions WHERE id = ?`,
				sessionID).Scan(&start, &end); err != nil || start != 0.3 || end != 0.35 {
				t.Fatalf("session percentages = %g,%g, %v", start, end, err)
			}
		})
	}
}

func TestRereadingResetsProgressOnceAndStartsAttempt(t *testing.T) {
	f := newReadingFixture(t)
	f.pushLifecycle(t, progressMutation(1, 1000), "applied")
	old := f.lifecycleState(t).Progress
	f.service.now = func() time.Time { return time.UnixMilli(4000) }
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"rereading","started_at":3000}`, 3000), "applied")
	state := f.lifecycleState(t)
	if state.Progress.Percentage != 0 || state.Progress.Locator != nil || state.Progress.Rev <= old.Rev ||
		state.Progress.UpdatedAt.UnixMilli() != 4000 || state.Progress.Source != old.Source ||
		state.Progress.Device != old.Device || state.Progress.DeviceID != old.DeviceID ||
		*state.Progress.BookFileID != *old.BookFileID || state.UserBook.FinishedAt != nil {
		t.Fatalf("restart state = %+v / %+v", state.UserBook, state.Progress)
	}

	pulled, err := f.service.Pull(context.Background(), Viewer{UserID: 2}, old.Rev)
	if err != nil || len(pulled.Progress) != 1 || pulled.Progress[0].Percentage != 0 {
		t.Fatalf("reset pull = %+v, %v", pulled, err)
	}
	f.insertSession(t, 1, 2, 101, "web", time.UnixMilli(1000), 1, percent(0.2), percent(0.4))
	f.insertSession(t, 2, 2, 101, "web", time.UnixMilli(3000), 1, percent(0.4), percent(0.5))
	summary, err := f.service.GetReadingSummary(context.Background(), Viewer{UserID: 2}, 101, "UTC")
	if err != nil || len(summary.Attempts) != 2 || summary.Attempts[0].Number != 2 {
		t.Fatalf("restart summary = %+v, %v", summary.Attempts, err)
	}
	page, err := f.service.ListBookSessions(context.Background(), Viewer{UserID: 2}, 101, "", "UTC", 25, "")
	if err != nil || len(page.Items) != 2 || page.Items[0].Attempt != 2 || page.Items[1].Attempt != 1 {
		t.Fatalf("restart sessions = %+v, %v", page, err)
	}
	f.service.now = func() time.Time { return time.UnixMilli(5000) }
	f.pushLifecycle(t, progressMutation(0.5, 4500), "applied")
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"rereading","started_at":3000}`, 4500), "applied")
	if f.lifecycleState(t).Progress.Percentage != 0.5 {
		t.Fatal("reselecting re-reading reset progress")
	}
	f.service.now = func() time.Time { return time.UnixMilli(6000) }
	f.pushLifecycle(t, progressMutation(0.99, 5500), "applied")
	if f.lifecycleState(t).UserBook.Status != "finished" {
		t.Fatal("re-read did not finish")
	}
}

func TestRereadingWithoutProgressAndStaleRestart(t *testing.T) {
	f := newReadingFixture(t)
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"rereading"}`, 1000), "rejected")
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"finished"}`, 1000), "applied")
	f.service.now = func() time.Time { return time.UnixMilli(3000) }
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"rereading","started_at":1,"finished_at":2}`, 2500), "applied")
	state := f.lifecycleState(t)
	if state.Progress == nil || state.Progress.Percentage != 0 || state.UserBook.StartedAt == nil ||
		state.UserBook.StartedAt.UnixMilli() != 2500 || state.UserBook.FinishedAt != nil {
		t.Fatalf("re-read without progress = %+v", state)
	}
	f.service.now = func() time.Time { return time.UnixMilli(4000) }
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"finished"}`, 3500), "applied")
	before := f.lifecycleState(t)
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"rereading"}`, 3000), "stale")
	if !reflect.DeepEqual(before, f.lifecycleState(t)) {
		t.Fatal("stale re-read reset state")
	}
}

func TestServerRejectsInvalidLifecycleTransitions(t *testing.T) {
	tests := []struct{ from, to string }{
		{"", "rereading"}, {"unread", "on_hold"}, {"want_to_read", "rereading"},
		{"reading", "unread"}, {"reading", "want_to_read"}, {"reading", "rereading"},
		{"finished", "unread"}, {"finished", "want_to_read"}, {"finished", "on_hold"},
		{"abandoned", "on_hold"}, {"skimmed", "on_hold"}, {"on_hold", "rereading"},
	}
	for _, test := range tests {
		t.Run(test.from+"/"+test.to, func(t *testing.T) {
			f := newReadingFixture(t)
			if test.from != "" {
				if _, err := f.db.Writer.Exec(`INSERT INTO user_books
						(user_id,book_id,status,updated_at,rev) VALUES (2,101,?,100,0)`, test.from); err != nil {
					t.Fatal(err)
				}
			}
			before := f.lifecycleState(t)
			response, err := f.service.Push(context.Background(), Viewer{UserID: 2}, PushRequest{Mutations: []Mutation{
				mutation("user_books", "", "101", "upsert",
					fmt.Sprintf(`{"book_id":101,"status":%q}`, test.to), 1000),
			}})
			if err != nil || response.Results[0].Status != "rejected" || response.Results[0].Reason == "" {
				t.Fatalf("invalid transition response = %+v, %v", response, err)
			}
			if !reflect.DeepEqual(before, f.lifecycleState(t)) {
				t.Fatal("rejected transition changed state")
			}
		})
	}
}

func TestTerminalCyclesArchiveOnlyOnExplicitReread(t *testing.T) {
	f := newReadingFixture(t)
	f.pushLifecycle(t, progressMutation(0.4, 500), "applied")
	f.service.now = func() time.Time { return time.UnixMilli(3000) }
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"abandoned"}`, 2500), "applied")
	f.service.now = func() time.Time { return time.UnixMilli(4000) }
	f.pushLifecycle(t, progressMutation(1, 3500), "applied")
	if f.lifecycleState(t).UserBook.Status != "abandoned" {
		t.Fatal("abandoned auto-finished")
	}
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"skimmed"}`, 3600), "applied")
	if f.lifecycleState(t).UserBook.FinishedAt.UnixMilli() != 2500 {
		t.Fatal("terminal switch changed cycle end")
	}
	var count int
	if err := f.db.Reader.QueryRow(`SELECT count(*) FROM reading_cycles`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("terminal update archived a cycle: %d, %v", count, err)
	}
	f.service.now = func() time.Time { return time.UnixMilli(5000) }
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"rereading"}`, 4500), "applied")
	var started, ended int64
	var status string
	var percentage float64
	if err := f.db.Reader.QueryRow(`SELECT started_at,ended_at,status,percentage FROM reading_cycles`).
		Scan(&started, &ended, &status, &percentage); err != nil ||
		started != 2000 || ended != 2500 || status != "skimmed" || percentage != 1 {
		t.Fatalf("archived cycle = %d,%d,%s,%g, %v", started, ended, status, percentage, err)
	}
	before := f.lifecycleState(t)
	f.pushLifecycle(t, progressMutation(0.8, 3900), "stale")
	if !reflect.DeepEqual(before, f.lifecycleState(t)) {
		t.Fatal("pre-reread sync restored old progress")
	}
}

func TestHeldCycleResumesAndPullExposesResumeStatus(t *testing.T) {
	for _, reread := range []bool{false, true} {
		t.Run(fmt.Sprint(reread), func(t *testing.T) {
			f := newReadingFixture(t)
			f.pushLifecycle(t, progressMutation(0.2, 500), "applied")
			if reread {
				f.service.now = func() time.Time { return time.UnixMilli(3000) }
				f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
					`{"book_id":101,"status":"finished"}`, 2500), "applied")
				f.service.now = func() time.Time { return time.UnixMilli(4000) }
				f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
					`{"book_id":101,"status":"rereading"}`, 3500), "applied")
				f.service.now = func() time.Time { return time.UnixMilli(5000) }
				f.pushLifecycle(t, progressMutation(0.2, 4500), "applied")
			}
			f.service.now = func() time.Time { return time.UnixMilli(6000) }
			f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
				`{"book_id":101,"status":"on_hold"}`, 5500), "applied")
			want := "reading"
			if reread {
				want = "rereading"
			}
			if state := f.lifecycleState(t); state.UserBook.ResumeStatus != want {
				t.Fatalf("held resume status = %+v, want %s", state.UserBook, want)
			}
			pull, err := f.service.Pull(context.Background(), Viewer{UserID: 2}, 0)
			if err != nil || len(pull.UserBooks) != 1 || pull.UserBooks[0].ResumeStatus != want {
				t.Fatalf("held pull = %+v, %v", pull, err)
			}
			f.service.now = func() time.Time { return time.UnixMilli(7000) }
			f.pushLifecycle(t, progressMutation(0.2, 6500), "applied")
			if f.lifecycleState(t).UserBook.Status != "on_hold" {
				t.Fatal("unchanged progress echo resumed reading")
			}
			f.service.now = func() time.Time { return time.UnixMilli(8000) }
			f.pushLifecycle(t, progressMutation(0.3, 7500), "applied")
			if f.lifecycleState(t).UserBook.Status != want {
				t.Fatalf("held cycle did not resume %s", want)
			}
			f.service.now = func() time.Time { return time.UnixMilli(9000) }
			f.pushLifecycle(t, progressMutation(0.99, 8500), "applied")
			if f.lifecycleState(t).UserBook.Status != "finished" {
				t.Fatal("resumed cycle did not finish")
			}
		})
	}
}

func TestRereadArchiveAndResetAreAtomic(t *testing.T) {
	f := newReadingFixture(t)
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"finished"}`, 1000), "applied")
	before := f.lifecycleState(t)
	if _, err := f.db.Writer.Exec(`CREATE TRIGGER reject_reset BEFORE UPDATE ON reading_progress
			WHEN NEW.percentage = 0 BEGIN SELECT RAISE(ABORT, 'reset failed'); END`); err != nil {
		t.Fatal(err)
	}
	f.service.now = func() time.Time { return time.UnixMilli(3000) }
	_, err := f.service.Push(context.Background(), Viewer{UserID: 2}, PushRequest{Mutations: []Mutation{
		mutation("user_books", "", "101", "upsert", `{"book_id":101,"status":"rereading"}`, 2500),
	}})
	if err == nil {
		t.Fatal("reset failure was ignored")
	}
	var count int
	if err := f.db.Reader.QueryRow(`SELECT count(*) FROM reading_cycles`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled-back archive count = %d, %v", count, err)
	}
	if !reflect.DeepEqual(before, f.lifecycleState(t)) {
		t.Fatal("failed reset did not roll back status and progress")
	}
}

func TestManualTerminalProgressAndCycleClock(t *testing.T) {
	for _, status := range []string{"finished", "skimmed", "abandoned"} {
		t.Run(status, func(t *testing.T) {
			f := newReadingFixture(t)
			f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
				fmt.Sprintf(`{"book_id":101,"status":%q}`, status), 1000), "applied")
			state := f.lifecycleState(t)
			if status == "abandoned" {
				if state.Progress != nil {
					t.Fatal("abandoned manufactured progress")
				}
			} else if state.Progress == nil || state.Progress.Percentage != 1 {
				t.Fatal("manual completion did not create complete progress")
			}
			f.service.now = func() time.Time { return time.UnixMilli(3000) }
			f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
				`{"book_id":101,"status":"rereading"}`, 2500), "applied")
			if state = f.lifecycleState(t); state.UserBook.ReadingCycle != 2 || state.Progress.Percentage != 0 {
				t.Fatalf("new cycle = %+v", state)
			}
			f.service.now = func() time.Time { return time.UnixMilli(4000) }
			f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
				`{"book_id":101,"status":"rereading","started_at":1,"rating":8}`, 3500), "applied")
			f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
				`{"book_id":101,"status":"on_hold","started_at":1}`, 3600), "applied")
			if state = f.lifecycleState(t); state.UserBook.ReadingCycle != 2 || state.UserBook.ResumeStatus != "rereading" {
				t.Fatalf("edited dates lost cycle identity = %+v", state.UserBook)
			}
			f.service.now = func() time.Time { return time.UnixMilli(5000) }
			f.pushLifecycle(t, progressMutation(0.1, 4500), "applied")
			if f.lifecycleState(t).UserBook.Status != "rereading" {
				t.Fatal("held reread with edited dates did not resume")
			}
		})
	}
}

func TestArchivePreservesUniqueHistoricalEndAndHandlesCollisions(t *testing.T) {
	for _, originalEnd := range []int64{1000, 2000} {
		t.Run(fmt.Sprint(originalEnd), func(t *testing.T) {
			f := newReadingFixture(t)
			if _, err := f.db.Writer.Exec(`INSERT INTO reading_cycles
						(user_id,book_id,started_at,ended_at,status,percentage)
						VALUES (2,101,100,2000,'finished',1)`); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Writer.Exec(`INSERT INTO user_books
						(user_id,book_id,status,started_at,finished_at,updated_at,rev)
						VALUES (2,101,'abandoned',500,?,2500,0)`, originalEnd); err != nil {
				t.Fatal(err)
			}
			f.service.now = func() time.Time { return time.UnixMilli(4000) }
			f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
				`{"book_id":101,"status":"rereading"}`, 3500), "applied")
			var ended int64
			if err := f.db.Reader.QueryRow(`SELECT ended_at FROM reading_cycles ORDER BY id DESC LIMIT 1`).Scan(&ended); err != nil {
				t.Fatal(err)
			}
			want := originalEnd
			if originalEnd == 2000 {
				want = 4000
			}
			if ended != want {
				t.Fatalf("archived end = %d, want %d", ended, want)
			}
		})
	}
}
