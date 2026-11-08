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
	pulled, err := f.service.Pull(context.Background(), Viewer{UserID: 2}, cursor.Cursor)
	if err != nil || len(pulled.UserBooks) != 1 || pulled.UserBooks[0].Status != "finished" ||
		pulled.UserBooks[0].Rev <= cursor.Cursor {
		t.Fatalf("derived status pull = %+v, %v", pulled, err)
	}
}

func TestProgressPreservesManualStatusAndLWW(t *testing.T) {
	for _, status := range []string{"on_hold", "skimmed", "abandoned", "finished", "unread", "want_to_read"} {
		t.Run(status, func(t *testing.T) {
			f := newReadingFixture(t)
			f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
				fmt.Sprintf(`{"book_id":101,"status":%q,"rating":8,"started_at":50}`, status), 1000), "applied")
			f.pushLifecycle(t, progressMutation(0.995, 1200), "applied")
			state := f.lifecycleState(t)
			want := status
			if status == "unread" || status == "want_to_read" {
				want = "finished"
			}
			if state.UserBook.Status != want || state.UserBook.Rating == nil || *state.UserBook.Rating != 8 ||
				state.UserBook.StartedAt.UnixMilli() != 50 {
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
		`{"book_id":101,"status":"rereading"}`, 1000), "applied")
	state := f.lifecycleState(t)
	if state.Progress != nil || state.UserBook.StartedAt == nil || state.UserBook.StartedAt.UnixMilli() != 1000 {
		t.Fatalf("re-read without progress = %+v", state)
	}
	f.pushLifecycle(t, progressMutation(0.4, 1500), "applied")
	f.service.now = func() time.Time { return time.UnixMilli(3000) }
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"finished"}`, 2500), "applied")
	before := f.lifecycleState(t)
	f.pushLifecycle(t, mutation("user_books", "", "101", "upsert",
		`{"book_id":101,"status":"rereading"}`, 2000), "stale")
	if !reflect.DeepEqual(before, f.lifecycleState(t)) {
		t.Fatal("stale re-read reset state")
	}
}
