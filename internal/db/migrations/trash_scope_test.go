package migrations

import (
	"context"
	"testing"
)

func TestTrashScopeUpgradePreservesLiveData(t *testing.T) {
	ctx := context.Background()
	d, path := openTestDB(t)
	prior := newTestRunner(t, d.Writer, path, embeddedPrefixFS(t, 19), DefaultOptions())
	if err := prior.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES (1,'reader','x',1,1)`,
		`INSERT INTO libraries(id,name,slug,created_at,updated_at) VALUES (1,'Main','main',1,1)`,
		`INSERT INTO books(id,library_id,title,sort_title,created_at,updated_at) VALUES (1,1,'Book','book',1,1)`,
		`INSERT INTO wordbooks(id,user_id,name,created_at,updated_at) VALUES (1,1,'Words','x','x')`,
		`INSERT INTO wordbook_entries(id,wordbook_id,kind,text,dictionary_entries,source,created_at,updated_at,deleted_at)
			VALUES (1,1,'word','live','[]','{}','x','x',NULL), (2,1,'word','deleted','[]','{}','x','x',1)`,
		`INSERT INTO bookmarks(id,user_id,book_id,locator,created_at,updated_at,deleted_at,rev,purged)
			VALUES ('00000000-0000-0000-0000-000000000001',1,1,'{}',1,1,1,1,0),
			('00000000-0000-0000-0000-000000000002',1,1,'{}',1,1,1,1,1)`,
	} {
		if _, err := d.Writer.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	runner := newTestRunner(t, d.Writer, path, embedded, DefaultOptions())
	if err := runner.Up(ctx); err != nil {
		t.Fatal(err)
	}
	for query, want := range map[string]int{
		`SELECT count(*) FROM wordbook_entries WHERE text='live'`:                        1,
		`SELECT count(*) FROM wordbook_entries WHERE text='deleted'`:                     0,
		`SELECT count(*) FROM bookmarks WHERE id='00000000-0000-0000-0000-000000000001'`: 1,
		`SELECT count(*) FROM bookmarks WHERE id='00000000-0000-0000-0000-000000000002'`: 0,
	} {
		var got int
		if err := d.Reader.QueryRowContext(ctx, query).Scan(&got); err != nil || got != want {
			t.Fatalf("%s = %d, want %d: %v", query, got, want, err)
		}
	}
}
