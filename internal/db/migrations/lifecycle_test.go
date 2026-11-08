package migrations

import (
	"context"
	"database/sql"
	"testing"
)

func TestStatusLifecycleBackfill(t *testing.T) {
	ctx := context.Background()
	databases, path := openTestDB(t)
	v5 := newTestRunner(t, databases.Writer, path, embeddedPrefixFS(t, 5), DefaultOptions())
	if err := v5.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO users (id,username,password_hash,role,created_at,updated_at) VALUES (1,'reader','x','user',1,1)`,
		`INSERT INTO libraries (id,name,slug,created_at,updated_at) VALUES (1,'Main','main',1,1)`,
		`UPDATE sync_counter SET value = 100 WHERE id = 1`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		status string
		p      float64
		want   string
	}{
		{"", 0.3, "reading"}, {"unread", 0.995, "finished"}, {"want_to_read", 0.5, "reading"},
		{"on_hold", 0.5, "on_hold"}, {"reading", 1, "finished"}, {"unread", 0, "unread"},
		{"rereading", 0.99, "finished"}, {"skimmed", 1, "skimmed"}, {"abandoned", 1, "abandoned"},
		{"finished", 0.1, "finished"}, {"reading", 0.989, "reading"}, {"", 0, ""},
	}
	for i, test := range tests {
		id := i + 1
		if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO books
			(id,library_id,title,sort_title,created_at,updated_at) VALUES (?,1,'Book','book',1,1)`, id); err != nil {
			t.Fatal(err)
		}
		if test.status != "" {
			if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO user_books
				(user_id,book_id,status,rating,started_at,finished_at,updated_at,rev)
				VALUES (1,?,?,7,50,60,300,?)`, id, test.status, id); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO reading_progress
			(user_id,book_id,source,percentage,updated_at,rev) VALUES (1,?,'web',?,200,?)`, id, test.p, id+20); err != nil {
			t.Fatal(err)
		}
	}
	runner := newTestRunner(t, databases.Writer, path, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	revs := map[int64]bool{}
	for i, test := range tests {
		var status string
		var rating, started, finished sql.NullInt64
		var updated, rev int64
		err := databases.Writer.QueryRowContext(ctx, `SELECT status,rating,started_at,finished_at,updated_at,rev
			FROM user_books WHERE user_id = 1 AND book_id = ?`, i+1).Scan(&status, &rating, &started, &finished, &updated, &rev)
		if test.want == "" {
			if err != sql.ErrNoRows {
				t.Fatalf("zero progress without a row = %v", err)
			}
			continue
		}
		if err != nil || status != test.want {
			t.Fatalf("book %d status = %s, %v; want %s", i+1, status, err, test.want)
		}
		if test.status != "" && (rating.Int64 != 7 || started.Int64 != 50 || finished.Int64 != 60) {
			t.Fatalf("book %d lost existing fields", i+1)
		}
		if test.status == test.want {
			if updated != 300 || rev != int64(i+1) {
				t.Fatalf("unchanged book %d got a new clock/revision", i+1)
			}
		} else {
			if rev <= 100 || revs[rev] {
				t.Fatalf("backfill revision %d is old or duplicated", rev)
			}
			revs[rev] = true
			wantUpdated := int64(301)
			if test.status == "" {
				wantUpdated = 201
				if started.Int64 != 200 {
					t.Fatal("new status did not use progress timestamp")
				}
			}
			if updated != wantUpdated {
				t.Fatalf("updated = %d, want %d", updated, wantUpdated)
			}
		}
	}
	var counter int64
	if err := databases.Writer.QueryRowContext(ctx, `SELECT value FROM sync_counter WHERE id = 1`).Scan(&counter); err != nil {
		t.Fatal(err)
	}
	if len(revs) != 5 || counter != 105 {
		t.Fatalf("backfill revisions = %v, counter = %d", revs, counter)
	}
	if err := runner.DownTo(ctx, 5); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := databases.Writer.QueryRowContext(ctx, `SELECT status FROM user_books WHERE book_id = 2`).Scan(&status); err != nil || status != "finished" {
		t.Fatalf("down migration reverted user data: %s, %v", status, err)
	}
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	if err := databases.Writer.QueryRowContext(ctx, `SELECT value FROM sync_counter WHERE id = 1`).Scan(&counter); err != nil || counter != 105 {
		t.Fatalf("reapplying backfill changed revisions: %d, %v", counter, err)
	}
}
