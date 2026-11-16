package dictionary

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func openTestCache(t *testing.T, path string) *Cache {
	t.Helper()
	cache, err := OpenCache(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cache.Close() })
	return cache
}

func TestCachePath(t *testing.T) {
	if got, want := CachePath("data"), filepath.Join("data", "dictionaries", "cache.db"); got != want {
		t.Fatalf("CachePath = %q, want %q", got, want)
	}
}

func TestCacheRoundTripAndExpiry(t *testing.T) {
	ctx := context.Background()
	cache := openTestCache(t, CachePath(t.TempDir()))
	now := time.UnixMilli(1_700_000_000_000)

	if body, ok, err := cache.Get(ctx, 1, "word", now); err != nil || ok || body != nil {
		t.Fatalf("miss = %q, %v, %v", body, ok, err)
	}
	if err := cache.Put(ctx, 1, "full", []byte(`[{"a":1}]`), false, now); err != nil {
		t.Fatal(err)
	}
	if err := cache.Put(ctx, 1, "empty", []byte(`[]`), true, now); err != nil {
		t.Fatal(err)
	}
	if body, ok, err := cache.Get(ctx, 1, "full", now); err != nil || !ok || string(body) != `[{"a":1}]` {
		t.Fatalf("hit = %q, %v, %v", body, ok, err)
	}
	if _, ok, _ := cache.Get(ctx, 2, "full", now); ok {
		t.Fatal("other provider must miss")
	}

	if _, ok, _ := cache.Get(ctx, 1, "empty", now.Add(emptyCacheTTL-time.Millisecond)); !ok {
		t.Fatal("empty response expired early")
	}
	if _, ok, _ := cache.Get(ctx, 1, "empty", now.Add(emptyCacheTTL)); ok {
		t.Fatal("empty response must expire after emptyCacheTTL")
	}
	if _, ok, _ := cache.Get(ctx, 1, "full", now.Add(emptyCacheTTL)); !ok {
		t.Fatal("full response expired early")
	}
	if _, ok, _ := cache.Get(ctx, 1, "full", now.Add(cacheTTL)); ok {
		t.Fatal("full response must expire after cacheTTL")
	}

	// Upsert refreshes the body and expiry.
	later := now.Add(cacheTTL)
	if err := cache.Put(ctx, 1, "full", []byte(`[2]`), false, later); err != nil {
		t.Fatal(err)
	}
	if body, ok, _ := cache.Get(ctx, 1, "full", later); !ok || string(body) != `[2]` {
		t.Fatalf("upsert = %q, %v", body, ok)
	}
}

func TestCacheDeleteClearCount(t *testing.T) {
	ctx := context.Background()
	cache := openTestCache(t, CachePath(t.TempDir()))
	now := time.Now()
	for _, put := range []struct {
		provider int64
		request  string
	}{{1, "a"}, {1, "b"}, {2, "a"}} {
		if err := cache.Put(ctx, put.provider, put.request, []byte("x"), false, now); err != nil {
			t.Fatal(err)
		}
	}
	if count, err := cache.Count(ctx); err != nil || count != 3 {
		t.Fatalf("count = %d, %v", count, err)
	}
	if err := cache.DeleteProvider(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := cache.Get(ctx, 1, "a", now); ok {
		t.Fatal("deleted provider must miss")
	}
	if _, ok, _ := cache.Get(ctx, 2, "a", now); !ok {
		t.Fatal("other provider must remain")
	}
	if removed, err := cache.Clear(ctx); err != nil || removed != 1 {
		t.Fatalf("clear = %d, %v", removed, err)
	}
	if count, err := cache.Count(ctx); err != nil || count != 0 {
		t.Fatalf("count after clear = %d, %v", count, err)
	}
}

func TestCacheNilIsNoOp(t *testing.T) {
	ctx := context.Background()
	var cache *Cache
	if body, ok, err := cache.Get(ctx, 1, "a", time.Now()); body != nil || ok || err != nil {
		t.Fatal("nil Get must miss")
	}
	if err := cache.Put(ctx, 1, "a", []byte("x"), false, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := cache.DeleteProvider(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if n, err := cache.Clear(ctx); n != 0 || err != nil {
		t.Fatal("nil Clear must be 0")
	}
	if n, err := cache.Count(ctx); n != 0 || err != nil {
		t.Fatal("nil Count must be 0")
	}
	if err := cache.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCacheReopenPersists(t *testing.T) {
	ctx := context.Background()
	path := CachePath(t.TempDir())
	now := time.Now()
	cache, err := OpenCache(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := cache.Put(ctx, 7, "word", []byte("body"), false, now); err != nil {
		t.Fatal(err)
	}
	if err := cache.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := openTestCache(t, path)
	if body, ok, err := reopened.Get(ctx, 7, "word", now); err != nil || !ok || string(body) != "body" {
		t.Fatalf("reopened = %q, %v, %v", body, ok, err)
	}
}
