package dictionary

import (
	"cmp"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

// refreshInterval bounds how often an open store checks the sources table for a new import.
const refreshInterval = 30 * time.Second

// Store answers lookups from the dictionary database. It opens the file lazily and
// read-only, treats a missing file as an empty dictionary and notices later imports.
// It is safe for concurrent use.
type Store struct {
	path   string
	logger *slog.Logger
	now    func() time.Time

	mu         sync.Mutex
	db         *sql.DB
	simplifier *Simplifier
	stamp      sourcesStamp
	checkedAt  time.Time
	generation uint64
	closed     bool

	statusMu         sync.Mutex
	status           *Status
	statusGeneration uint64
}

type sourcesStamp struct {
	count      int64
	importedAt int64
	entries    int64
}

// NewStore returns a store for the database at path. Nothing is opened until first use.
func NewStore(path string, logger *slog.Logger) *Store {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Store{path: path, logger: logger, now: time.Now}
}

// Close releases the database handle. Later calls fail.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.db == nil {
		return nil
	}
	err := s.db.Close()
	s.db = nil
	s.simplifier = nil
	return err
}

// acquire returns the open database, the current simplifier and a generation that
// changes whenever imported data may have changed. A nil database means no dictionary
// is installed yet.
func (s *Store) acquire(ctx context.Context) (*sql.DB, *Simplifier, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, nil, 0, errors.New("dictionary store is closed")
	}
	if s.db == nil {
		database, err := Open(ctx, s.path, false)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, 0, nil
		}
		if err != nil {
			return nil, nil, 0, err
		}
		s.db = database
		s.simplifier = nil
		s.checkedAt = time.Time{}
	}
	now := s.now()
	if s.simplifier == nil || s.checkedAt.IsZero() || now.Sub(s.checkedAt) >= refreshInterval {
		if err := s.refreshLocked(ctx); err != nil {
			if isMissingTable(err) {
				// The importer created the file but not the schema yet.
				closeErr := s.db.Close()
				s.db = nil
				s.simplifier = nil
				if closeErr != nil {
					s.logger.Warn("close incomplete dictionary database", "error", closeErr)
				}
				return nil, nil, 0, nil
			}
			return nil, nil, 0, err
		}
		s.checkedAt = now
	}
	return s.db, s.simplifier, s.generation, nil
}

func (s *Store) refreshLocked(ctx context.Context) error {
	var stamp sourcesStamp
	if err := s.db.QueryRowContext(ctx,
		`SELECT count(*), coalesce(max(imported_at), 0), coalesce(sum(entry_count), 0) FROM sources`,
	).Scan(&stamp.count, &stamp.importedAt, &stamp.entries); err != nil {
		return fmt.Errorf("read dictionary sources: %w", err)
	}
	if s.simplifier != nil && stamp == s.stamp {
		return nil
	}
	simplifier, err := LoadSimplifier(ctx, s.db)
	if err != nil {
		return err
	}
	s.simplifier = simplifier
	s.stamp = stamp
	s.generation++
	s.logger.Debug("dictionary data loaded", "sources", stamp.count, "chineseVariants", simplifier.Len())
	return nil
}

func isMissingTable(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no such table")
}

// Status lists installed sources and the directions they serve.
func (s *Store) Status(ctx context.Context) (Status, error) {
	database, _, generation, err := s.acquire(ctx)
	if err != nil {
		return Status{}, err
	}
	if database == nil {
		return Status{Directions: []Direction{}, Sources: []SourceInfo{}}, nil
	}
	s.statusMu.Lock()
	defer s.statusMu.Unlock()
	if s.status == nil || s.statusGeneration != generation {
		status, err := loadStatus(ctx, database)
		if err != nil {
			return Status{}, err
		}
		s.status = &status
		s.statusGeneration = generation
	}
	return cloneStatus(*s.status), nil
}

func loadStatus(ctx context.Context, database *sql.DB) (Status, error) {
	status := Status{Directions: []Direction{}, Sources: []SourceInfo{}}
	rows, err := database.QueryContext(ctx,
		`SELECT id, name, license, url, entry_count, imported_at FROM sources`)
	if err != nil {
		return Status{}, fmt.Errorf("list dictionary sources: %w", err)
	}
	for rows.Next() {
		var info SourceInfo
		if err := rows.Scan(&info.ID, &info.Name, &info.License, &info.URL, &info.Entries, &info.ImportedAt); err != nil {
			rows.Close()
			return Status{}, fmt.Errorf("read dictionary source: %w", err)
		}
		status.Sources = append(status.Sources, info)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return Status{}, fmt.Errorf("list dictionary sources: %w", err)
	}
	slices.SortFunc(status.Sources, func(a, b SourceInfo) int {
		return cmp.Or(cmp.Compare(sourceOrder(a.ID), sourceOrder(b.ID)), strings.Compare(a.ID, b.ID))
	})

	rows, err = database.QueryContext(ctx,
		`SELECT source_id, from_lang, to_lang FROM entries GROUP BY source_id, from_lang, to_lang`)
	if err != nil {
		return Status{}, fmt.Errorf("list dictionary directions: %w", err)
	}
	type pair struct{ from, to Lang }
	served := map[pair][]string{}
	for rows.Next() {
		var source, from, to string
		if err := rows.Scan(&source, &from, &to); err != nil {
			rows.Close()
			return Status{}, fmt.Errorf("read dictionary direction: %w", err)
		}
		fromLang, okFrom := ParseLang(from)
		toLang, okTo := ParseLang(to)
		if !okFrom || !okTo {
			continue
		}
		key := pair{fromLang, toLang}
		served[key] = append(served[key], source)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return Status{}, fmt.Errorf("list dictionary directions: %w", err)
	}
	for _, from := range Languages {
		for _, to := range Languages {
			sources := served[pair{from, to}]
			if len(sources) == 0 {
				continue
			}
			slices.SortFunc(sources, func(a, b string) int {
				return cmp.Or(cmp.Compare(sourceOrder(a), sourceOrder(b)), strings.Compare(a, b))
			})
			status.Directions = append(status.Directions, Direction{From: from, To: to, Sources: sources})
		}
	}
	return status, nil
}

func cloneStatus(status Status) Status {
	out := Status{Directions: make([]Direction, len(status.Directions)), Sources: slices.Clone(status.Sources)}
	for index, direction := range status.Directions {
		direction.Sources = slices.Clone(direction.Sources)
		out.Directions[index] = direction
	}
	return out
}

// sourceOrder is the registry position of a source; unknown sources sort last.
func sourceOrder(id string) int {
	if _, index, ok := SourceByID(id); ok {
		return index
	}
	return len(Sources)
}

func sourceName(id string) string {
	if spec, _, ok := SourceByID(id); ok {
		return spec.Name
	}
	return id
}
