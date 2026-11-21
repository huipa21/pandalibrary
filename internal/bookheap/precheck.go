package bookheap

import (
	"context"
	"database/sql"
	"fmt"
	"math"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db/sqlc"
)

// MaxPrecheckFiles bounds one preflight request. Each hash is queried once.
const MaxPrecheckFiles = 1000

// PrecheckMatch reports whether a SHA-256 already exists in the destination
// library or among unassigned Bookheap items. Both references may be set.
type PrecheckMatch struct {
	SHA256            string `json:"sha256"`
	DuplicateOfBookID *int64 `json:"duplicate_of_book_id"`
	DuplicateOfItemID *int64 `json:"duplicate_of_item_id"`
}

// Precheck looks up file hashes before any content is uploaded. Duplicate
// detection remains authoritative in Commit and in the importer, which also
// handle races between this check and the actual upload.
func (s *Service) Precheck(ctx context.Context, viewer catalog.Viewer, libraryID int64, hashes []string) ([]PrecheckMatch, error) {
	if err := checkAdmin(viewer); err != nil {
		return nil, err
	}
	if s.isStopped() {
		return nil, ErrStopped
	}
	if libraryID < 1 {
		return nil, fmt.Errorf("%w: the library ID is invalid", catalog.ErrInvalid)
	}
	if len(hashes) == 0 || len(hashes) > MaxPrecheckFiles {
		return nil, fmt.Errorf("%w: between 1 and %d hashes are required", catalog.ErrInvalid, MaxPrecheckFiles)
	}

	queries := sqlc.New(s.reader)
	cache := make(map[string]PrecheckMatch, len(hashes))
	results := make([]PrecheckMatch, len(hashes))
	for index, sha := range hashes {
		if !blobstore.ValidHash(sha) {
			return nil, fmt.Errorf("%w: a SHA-256 digest is invalid", catalog.ErrInvalid)
		}
		match, found := cache[sha]
		if !found {
			match = PrecheckMatch{SHA256: sha}
			bookID, err := queries.ImportDuplicate(ctx, sqlc.ImportDuplicateParams{Sha256: sha, LibraryID: libraryID})
			switch {
			case err == nil:
				match.DuplicateOfBookID = &bookID
			case !isNoRows(err):
				return nil, fmt.Errorf("precheck library duplicate: %w", err)
			}
			itemID, err := queries.BookheapDuplicateItem(ctx, sqlc.BookheapDuplicateItemParams{Sha256: sql.NullString{String: sha, Valid: true}, BeforeID: math.MaxInt64})
			switch {
			case err == nil:
				match.DuplicateOfItemID = &itemID
			case !isNoRows(err):
				return nil, fmt.Errorf("precheck heap duplicate: %w", err)
			}
			cache[sha] = match
		}
		results[index] = match
	}
	return results, nil
}

func isNoRows(err error) bool {
	return err == sql.ErrNoRows
}
