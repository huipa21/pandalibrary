package db

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func TestOpenAppliesConnectionPragmas(t *testing.T) {
	databases, err := Open(context.Background(), filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer databases.Close()

	const readerCount = 4
	connections := make([]*sql.Conn, 0, readerCount)
	for range readerCount {
		connection, err := databases.Reader.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, connection)
	}
	defer func() {
		for _, connection := range connections {
			if err := connection.Close(); err != nil {
				t.Errorf("close reader connection: %v", err)
			}
		}
	}()

	for _, connection := range connections {
		assertPragma(t, connection, "query_only", 1)
		assertPragma(t, connection, "foreign_keys", 1)
		assertPragma(t, connection, "busy_timeout", busyTimeoutMS)
		assertPragma(t, connection, "temp_store", 2)
		assertPragma(t, connection, "cache_size", -cacheSizeKiB)
		assertPragma(t, connection, "synchronous", 1)
		var journalMode string
		if err := connection.QueryRowContext(context.Background(), "PRAGMA journal_mode").Scan(&journalMode); err != nil {
			t.Fatal(err)
		}
		if journalMode != "wal" {
			t.Errorf("journal_mode = %q, want wal", journalMode)
		}
	}

	assertPragma(t, databases.Writer, "foreign_keys", 1)
	assertPragma(t, databases.Writer, "busy_timeout", busyTimeoutMS)
	assertPragma(t, databases.Writer, "temp_store", 2)
	assertPragma(t, databases.Writer, "cache_size", -cacheSizeKiB)
	assertPragma(t, databases.Writer, "synchronous", 1)
	if databases.Writer.Stats().MaxOpenConnections != 1 {
		t.Fatalf("writer max open connections = %d, want 1", databases.Writer.Stats().MaxOpenConnections)
	}
	if databases.Reader.Stats().MaxOpenConnections < 4 {
		t.Fatalf("reader max open connections = %d, want at least 4", databases.Reader.Stats().MaxOpenConnections)
	}
	assertPragma(t, databases.Writer, "query_only", 0)
	if _, err := databases.Reader.ExecContext(context.Background(), "CREATE TABLE query_only_test (id INTEGER)"); err == nil {
		t.Fatal("reader pool accepted a write")
	}
}

func TestOpenInMemorySharesWriterAndReader(t *testing.T) {
	ctx := context.Background()
	databases, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer databases.Close()
	if _, err := databases.Writer.ExecContext(ctx, "CREATE TABLE shared_test (value INTEGER)"); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx, "INSERT INTO shared_test (value) VALUES (7)"); err != nil {
		t.Fatal(err)
	}
	var value int
	if err := databases.Reader.QueryRowContext(ctx, "SELECT value FROM shared_test").Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != 7 {
		t.Fatalf("reader value = %d, want 7", value)
	}
}

func TestWithTxAndNextRev(t *testing.T) {
	ctx := context.Background()
	databases, err := Open(ctx, filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer databases.Close()
	if _, err := databases.Writer.ExecContext(ctx, "CREATE TABLE sync_counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO sync_counter (id, value) VALUES (1, 0)"); err != nil {
		t.Fatal(err)
	}

	for want := int64(1); want <= 2; want++ {
		var got int64
		err := WithTx(ctx, databases.Writer, func(tx *sql.Tx) error {
			var err error
			got, err = NextRev(ctx, tx)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("NextRev() = %d, want %d", got, want)
		}
	}

	callbackErr := errors.New("callback failed")
	err = WithTx(ctx, databases.Writer, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, "UPDATE sync_counter SET value = 99 WHERE id = 1"); err != nil {
			return err
		}
		return callbackErr
	})
	if !errors.Is(err, callbackErr) {
		t.Fatalf("WithTx() error = %v, want callback error", err)
	}
	var value int64
	if err := databases.Writer.QueryRowContext(ctx, "SELECT value FROM sync_counter WHERE id = 1").Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != 2 {
		t.Fatalf("rolled-back sync_counter value = %d, want 2", value)
	}
}

func assertPragma(t *testing.T, database interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, name string, want int) {
	t.Helper()
	var got int
	if err := database.QueryRowContext(context.Background(), "PRAGMA "+name).Scan(&got); err != nil {
		t.Fatalf("read pragma %s: %v", name, err)
	}
	if got != want {
		t.Errorf("pragma %s = %d, want %d", name, got, want)
	}
}
