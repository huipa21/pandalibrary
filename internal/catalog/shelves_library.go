package catalog

import (
	"context"
	"fmt"

	"pandalibrary/internal/db/sqlc"
)

// An omitted library leaves shelves reusable across the whole visible catalog.
func shelfLibraryID(ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	if len(ids) != 1 || ids[0] < 1 {
		return 0, invalid("library ID must be positive")
	}
	return ids[0], nil
}

func checkShelfLibrary(ctx context.Context, queries *sqlc.Queries, viewer Viewer, libraryID int64) error {
	if libraryID == 0 {
		return nil
	}
	_, err := libraryInTx(ctx, queries, viewer, libraryID)
	return err
}

func shelfLibraryScope(scope string, libraryID int64) string {
	if libraryID == 0 {
		return scope
	}
	return fmt.Sprintf("%s:library:%d", scope, libraryID)
}
