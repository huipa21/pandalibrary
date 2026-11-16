package dictionary

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Cache keeps raw successful provider responses in a separate SQLite file
// (<data-dir>/dictionaries/cache.db). Word meanings rarely change, so entries live long.
// It is safe for concurrent use.
type Cache struct {
	db *sql.DB

	mu        sync.Mutex
	puts      int
	lastPrune time.Time
}

const (
	// cacheTTL bounds responses that contained entries.
	cacheTTL = 365 * 24 * time.Hour
	// emptyCacheTTL bounds responses without entries, so new words are retried sooner.
	emptyCacheTTL = 7 * 24 * time.Hour

	cachePruneEvery    = 1000
	cachePruneInterval = time.Hour
)

const cacheSchema = `
CREATE TABLE IF NOT EXISTS responses (
	provider_id INTEGER NOT NULL,
	request TEXT NOT NULL,
	body BLOB NOT NULL,
	empty INTEGER NOT NULL,
	fetched_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (provider_id, request)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS responses_expires ON responses(expires_at);
`

// CachePath is the cache database location inside the data directory.
func CachePath(dataDir string) string {
	return filepath.Join(dataDir, "dictionaries", "cache.db")
}

// OpenCache opens or creates the cache database, creating its directory.
func OpenCache(ctx context.Context, path string) (*Cache, error) {
	if path == "" {
		return nil, errors.New("dictionary cache path must not be empty")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve dictionary cache path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o750); err != nil {
		return nil, fmt.Errorf("create dictionary cache directory: %w", err)
	}
	values := url.Values{}
	values.Add("_pragma", "journal_mode(WAL)")
	values.Add("_pragma", "synchronous(NORMAL)")
	values.Add("_pragma", "busy_timeout(5000)")
	values.Add("_pragma", "temp_store(MEMORY)")
	database, err := sql.Open("sqlite", absolute+"?"+values.Encode())
	if err != nil {
		return nil, fmt.Errorf("open dictionary cache: %w", err)
	}
	database.SetMaxOpenConns(1)
	if _, err := database.ExecContext(ctx, cacheSchema); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("create dictionary cache schema: %w", err)
	}
	return &Cache{db: database}, nil
}

// Get returns the cached body for (providerID, request) unless it expired at now.
func (c *Cache) Get(ctx context.Context, providerID int64, request string, now time.Time) ([]byte, bool, error) {
	if c == nil || c.db == nil {
		return nil, false, nil
	}
	var body []byte
	err := c.db.QueryRowContext(ctx,
		`SELECT body FROM responses WHERE provider_id = ? AND request = ? AND expires_at > ?`,
		providerID, request, now.UnixMilli()).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read dictionary cache: %w", err)
	}
	if body == nil {
		body = []byte{}
	}
	return body, true, nil
}

// Put stores body; empty selects the shorter expiry.
func (c *Cache) Put(ctx context.Context, providerID int64, request string, body []byte, empty bool, now time.Time) error {
	if c == nil || c.db == nil {
		return nil
	}
	ttl := cacheTTL
	if empty {
		ttl = emptyCacheTTL
	}
	if body == nil {
		body = []byte{}
	}
	_, err := c.db.ExecContext(ctx, `
INSERT INTO responses (provider_id, request, body, empty, fetched_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (provider_id, request) DO UPDATE SET
	body = excluded.body, empty = excluded.empty,
	fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
		providerID, request, body, empty, now.UnixMilli(), now.Add(ttl).UnixMilli())
	if err != nil {
		return fmt.Errorf("write dictionary cache: %w", err)
	}
	if c.shouldPrune(now) {
		// Best effort: a failed prune only delays reclaiming space.
		_, _ = c.db.ExecContext(ctx, `DELETE FROM responses WHERE expires_at <= ?`, now.UnixMilli())
	}
	return nil
}

func (c *Cache) shouldPrune(now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.puts++
	if c.lastPrune.IsZero() {
		c.lastPrune = now
		return false
	}
	if c.puts >= cachePruneEvery || now.Sub(c.lastPrune) >= cachePruneInterval {
		c.puts = 0
		c.lastPrune = now
		return true
	}
	return false
}

// DeleteProvider removes every cached response of one provider.
func (c *Cache) DeleteProvider(ctx context.Context, providerID int64) error {
	if c == nil || c.db == nil {
		return nil
	}
	if _, err := c.db.ExecContext(ctx, `DELETE FROM responses WHERE provider_id = ?`, providerID); err != nil {
		return fmt.Errorf("delete dictionary cache entries: %w", err)
	}
	return nil
}

// Clear removes every cached response and returns how many were removed.
func (c *Cache) Clear(ctx context.Context) (int64, error) {
	if c == nil || c.db == nil {
		return 0, nil
	}
	result, err := c.db.ExecContext(ctx, `DELETE FROM responses`)
	if err != nil {
		return 0, fmt.Errorf("clear dictionary cache: %w", err)
	}
	removed, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("clear dictionary cache: %w", err)
	}
	return removed, nil
}

// Count returns the number of cached responses, including expired ones not yet pruned.
func (c *Cache) Count(ctx context.Context) (int64, error) {
	if c == nil || c.db == nil {
		return 0, nil
	}
	var count int64
	if err := c.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM responses`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count dictionary cache entries: %w", err)
	}
	return count, nil
}

// Close releases the database handle.
func (c *Cache) Close() error {
	if c == nil || c.db == nil {
		return nil
	}
	return c.db.Close()
}
