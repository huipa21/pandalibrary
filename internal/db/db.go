package db

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	_ "modernc.org/sqlite"
)

const (
	busyTimeoutMS = 5000
	cacheSizeKiB  = 64 * 1024
)

// DB owns separate writer and query-only reader pools for one SQLite database.
type DB struct {
	Writer *sql.DB
	Reader *sql.DB
}

// Open creates the database directory and opens configured writer and reader pools.
func Open(ctx context.Context, path string) (*DB, error) {
	if path == "" {
		return nil, errors.New("database path must not be empty")
	}
	if path == ":memory:" {
		var name [16]byte
		if _, err := rand.Read(name[:]); err != nil {
			return nil, fmt.Errorf("generate in-memory database name: %w", err)
		}
		path = fmt.Sprintf("file:pandalibrary-%x?mode=memory&cache=shared", name)
	} else {
		absolutePath, err := filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("resolve database path: %w", err)
		}
		path = absolutePath
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}

	writer, err := openPool(path, false, 1)
	if err != nil {
		return nil, fmt.Errorf("open database writer: %w", err)
	}
	readers, err := openPool(path, true, max(4, runtime.NumCPU()))
	if err != nil {
		return nil, errors.Join(fmt.Errorf("open database readers: %w", err), closeDatabase(writer))
	}
	databases := &DB{Writer: writer, Reader: readers}

	if err := writer.PingContext(ctx); err != nil {
		return nil, errors.Join(fmt.Errorf("ping database writer: %w", err), databases.Close())
	}
	if err := readers.PingContext(ctx); err != nil {
		return nil, errors.Join(fmt.Errorf("ping database readers: %w", err), databases.Close())
	}
	return databases, nil
}

func openPool(path string, queryOnly bool, maxConnections int) (*sql.DB, error) {
	values := url.Values{}
	values.Add("_pragma", "journal_mode(WAL)")
	values.Add("_pragma", "synchronous(NORMAL)")
	values.Add("_pragma", "foreign_keys(ON)")
	values.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeoutMS))
	values.Add("_pragma", "temp_store(MEMORY)")
	values.Add("_pragma", fmt.Sprintf("cache_size(-%d)", cacheSizeKiB))
	if queryOnly {
		values.Add("_pragma", "query_only(ON)")
	} else {
		values.Set("_txlock", "immediate")
	}

	dsn := path
	if strings.HasPrefix(path, "file:") {
		uri, err := url.Parse(path)
		if err != nil {
			return nil, fmt.Errorf("parse SQLite URI: %w", err)
		}
		query := uri.Query()
		for key, entries := range values {
			for _, entry := range entries {
				query.Add(key, entry)
			}
		}
		uri.RawQuery = query.Encode()
		dsn = uri.String()
	} else {
		dsn += "?" + values.Encode()
	}
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(maxConnections)
	database.SetMaxIdleConns(maxConnections)
	database.SetConnMaxLifetime(0)
	return database, nil
}

// Close closes both pools and returns every close error.
func (d *DB) Close() error {
	if d == nil {
		return nil
	}
	var errs []error
	if d.Writer != nil {
		if err := d.Writer.Close(); err != nil {
			errs = append(errs, fmt.Errorf("close writer: %w", err))
		}
	}
	if d.Reader != nil {
		if err := d.Reader.Close(); err != nil {
			errs = append(errs, fmt.Errorf("close readers: %w", err))
		}
	}
	return errors.Join(errs...)
}

func closeDatabase(database *sql.DB) error {
	if err := database.Close(); err != nil {
		return fmt.Errorf("close writer: %w", err)
	}
	return nil
}

// WithTx runs fn in a transaction and returns callback, rollback, and commit errors.
func WithTx(ctx context.Context, database *sql.DB, fn func(*sql.Tx) error) error {
	if database == nil {
		return errors.New("database must not be nil")
	}
	if fn == nil {
		return errors.New("transaction callback must not be nil")
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	if err := fn(tx); err != nil {
		rollbackErr := tx.Rollback()
		if rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			return errors.Join(err, fmt.Errorf("rollback transaction: %w", rollbackErr))
		}
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// NextRev increments and returns the global sync revision within tx.
func NextRev(ctx context.Context, tx *sql.Tx) (int64, error) {
	if tx == nil {
		return 0, errors.New("transaction must not be nil")
	}
	var rev int64
	if err := tx.QueryRowContext(ctx,
		"UPDATE sync_counter SET value = value + 1 WHERE id = 1 RETURNING value",
	).Scan(&rev); err != nil {
		return 0, fmt.Errorf("increment sync revision: %w", err)
	}
	return rev, nil
}
