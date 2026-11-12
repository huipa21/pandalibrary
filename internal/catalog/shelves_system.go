package catalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

const (
	favoritesDefaultName = "Favorites"
	unshelvedDefaultName = "Unshelved"
)

// SystemShelf is the metadata envelope for a stable system shelf. Name is an English
// default; clients localize by Key. ShelfID is null for the virtual Unshelved view.
type SystemShelf struct {
	Key              string `json:"key"`
	Name             string `json:"name"`
	Mode             string `json:"mode"`
	VisibleBookCount int64  `json:"visible_book_count"`
	ShelfID          *int64 `json:"shelf_id"`
}

func checkSystemKey(key string) error {
	if key != SystemShelfFavorites && key != SystemShelfUnshelved {
		return fmt.Errorf("%w: unsupported system shelf key", ErrNotFound)
	}
	return nil
}

func systemShelfRow(ctx context.Context, queries *sqlc.Queries, ownerID int64, key string) (sqlc.Shelf, error) {
	return queries.ShelfSystemGet(ctx, sqlc.ShelfSystemGetParams{
		OwnerID: sql.NullInt64{Int64: ownerID, Valid: true}, SystemKey: sql.NullString{String: key, Valid: true},
	})
}

// ensureFavorites returns the viewer's Favorites shelf ID, creating it at most once.
// The common path is a read; the insert runs on the writer and is idempotent through
// the unique (owner_id, system_key) index, so concurrent first requests are safe.
func (s *Service) ensureFavorites(ctx context.Context, viewer Viewer) (int64, error) {
	id, err := readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (int64, error) {
		row, err := systemShelfRow(ctx, queries, viewer.UserID, SystemShelfFavorites)
		if err != nil {
			return 0, err
		}
		return row.ID, nil
	})
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("find favorites shelf: %w", err)
	}
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		now := s.now().UnixMilli()
		if err := queries.ShelfSystemEnsure(ctx, sqlc.ShelfSystemEnsureParams{
			OwnerID: sql.NullInt64{Int64: viewer.UserID, Valid: true}, Name: favoritesDefaultName,
			Now: now, SystemKey: sql.NullString{String: SystemShelfFavorites, Valid: true},
		}); err != nil {
			return fmt.Errorf("provision favorites shelf: %w", err)
		}
		row, err := systemShelfRow(ctx, queries, viewer.UserID, SystemShelfFavorites)
		if err != nil {
			return fmt.Errorf("load favorites shelf: %w", err)
		}
		id = row.ID
		return nil
	})
	return id, err
}

// GetSystemShelf returns metadata for the viewer's own Unshelved or Favorites shelf,
// with counts optionally intersected with one accessible library.
func (s *Service) GetSystemShelf(ctx context.Context, viewer Viewer, key string, libraryIDs ...int64) (SystemShelf, error) {
	if err := checkViewer(viewer); err != nil {
		return SystemShelf{}, err
	}
	if err := checkSystemKey(key); err != nil {
		return SystemShelf{}, err
	}
	libraryID, err := shelfLibraryID(libraryIDs)
	if err != nil {
		return SystemShelf{}, err
	}
	if key == SystemShelfFavorites {
		id, err := s.ensureFavorites(ctx, viewer)
		if err != nil {
			return SystemShelf{}, err
		}
		shelf, err := s.GetShelf(ctx, viewer, id, libraryIDs...)
		if err != nil {
			return SystemShelf{}, err
		}
		return SystemShelf{
			Key: key, Name: shelf.Name, Mode: shelf.Mode, VisibleBookCount: shelf.VisibleBookCount, ShelfID: &id,
		}, nil
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (SystemShelf, error) {
		if err := checkShelfLibrary(ctx, queries, viewer, libraryID); err != nil {
			return SystemShelf{}, err
		}
		count, err := queries.ShelfUnshelvedBookCount(ctx, sqlc.ShelfUnshelvedBookCountParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID, LibraryID: libraryID,
		})
		if err != nil {
			return SystemShelf{}, fmt.Errorf("count unshelved books: %w", err)
		}
		return SystemShelf{
			Key: key, Name: unshelvedDefaultName, Mode: ShelfModeAutomatic, VisibleBookCount: count,
		}, nil
	})
}

// ListSystemShelfBooks lists the viewer's Unshelved or Favorites books. Favorites use
// the numeric shelf's manual order and cursors; Unshelved is ordered by sort title and ID.
// An optional positive library ID scopes both membership and cursors.
func (s *Service) ListSystemShelfBooks(ctx context.Context, viewer Viewer, key string, options PageOptions, libraryIDs ...int64) (Page[Book], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Book]{}, err
	}
	if err := checkSystemKey(key); err != nil {
		return Page[Book]{}, err
	}
	libraryID, err := shelfLibraryID(libraryIDs)
	if err != nil {
		return Page[Book]{}, err
	}
	if key == SystemShelfFavorites {
		if options.Limit != 0 && (options.Limit < 1 || options.Limit > maximumPageSize) {
			return Page[Book]{}, invalid("limit must be between 1 and 100")
		}
		id, err := s.ensureFavorites(ctx, viewer)
		if err != nil {
			return Page[Book]{}, err
		}
		return s.ListShelfBooks(ctx, viewer, id, options, libraryIDs...)
	}
	scope := shelfLibraryScope(fmt.Sprintf("%s:%s", viewerScope(viewer), SystemShelfUnshelved), libraryID)
	limit, after, err := parsePage(options, "system_shelf_books", scope, "title")
	if err != nil {
		return Page[Book]{}, err
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[Book], error) {
		if err := checkShelfLibrary(ctx, queries, viewer, libraryID); err != nil {
			return Page[Book]{}, err
		}
		rows, err := queries.ShelfUnshelvedBooks(ctx, sqlc.ShelfUnshelvedBooksParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID, LibraryID: libraryID,
			AfterID: after.ID, AfterTitle: after.Text, PageSize: int64(limit + 1),
		})
		if err != nil {
			return Page[Book]{}, fmt.Errorf("list unshelved books: %w", err)
		}
		return titlePage(ctx, queries, viewer, rows, limit, "system_shelf_books", scope)
	})
}
