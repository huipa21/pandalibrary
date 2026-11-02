package auth

import (
	"sync"
	"time"
)

const (
	authRateWindow = 10 * time.Minute
	authRateMax    = 5
	authRateMaxIPs = 4096
)

type rateEntry struct {
	count   int
	expires time.Time
}

// RateLimiter bounds its state and limits requests per client key for an interval.
type RateLimiter struct {
	mu      sync.Mutex
	entries map[string]rateEntry
	sweepAt time.Time
}

func NewRateLimiter() *RateLimiter {
	return &RateLimiter{entries: make(map[string]rateEntry)}
}

// Allow records an attempt and returns false once the key exceeds the limit.
func (l *RateLimiter) Allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !now.Before(l.sweepAt) {
		for existing, entry := range l.entries {
			if !now.Before(entry.expires) {
				delete(l.entries, existing)
			}
		}
		l.sweepAt = now.Add(time.Minute)
	}
	entry, ok := l.entries[key]
	if !ok {
		if len(l.entries) >= authRateMaxIPs {
			return false
		}
		entry.expires = now.Add(authRateWindow)
	}
	if entry.count >= authRateMax {
		return false
	}
	entry.count++
	l.entries[key] = entry
	return true
}

// Reset clears attempts for a key after a successful operation.
func (l *RateLimiter) Reset(key string) {
	l.mu.Lock()
	delete(l.entries, key)
	l.mu.Unlock()
}
