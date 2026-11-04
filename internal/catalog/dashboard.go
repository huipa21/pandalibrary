package catalog

import (
	"context"
	"fmt"
	"slices"

	"pandalibrary/internal/db/sqlc"
)

// ListDashboardBooks returns a visibility-filtered, keyset-paginated feed of books for a dashboard section.
// Supported sections: continue_reading, recently_added, read, unread, want_to_read.
func (s *Service) ListDashboardBooks(ctx context.Context, viewer Viewer, section string, options PageOptions) (Page[Book], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Book]{}, err
	}

	// Validate section
	validSections := []string{"continue_reading", "recently_added", "read", "unread", "want_to_read"}
	if !slices.Contains(validSections, section) {
		return Page[Book]{}, invalid(fmt.Sprintf("dashboard section %q is not supported", section))
	}

	scope := fmt.Sprintf("%s:%s", viewerScope(viewer), section)
	limit, after, err := parsePage(options, "dashboard_books", scope, section)
	if err != nil {
		return Page[Book]{}, err
	}

	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[Book], error) {
		// Query all book IDs based on section (pagination will be done in-memory)
		var ids []int64
		switch section {
		case "continue_reading":
			rows, err := queries.DashboardContinueReadingBooks(ctx, sqlc.DashboardContinueReadingBooksParams{
				IsAdmin: adminFlag(viewer),
				UserID:  viewer.UserID,
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list continue reading books: %w", err)
			}
			ids = rows

		case "recently_added":
			rows, err := queries.DashboardRecentlyAddedBooks(ctx, sqlc.DashboardRecentlyAddedBooksParams{
				IsAdmin: adminFlag(viewer),
				UserID:  viewer.UserID,
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list recently added books: %w", err)
			}
			ids = rows

		case "read":
			rows, err := queries.DashboardReadBooks(ctx, sqlc.DashboardReadBooksParams{
				IsAdmin: adminFlag(viewer),
				UserID:  viewer.UserID,
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list read books: %w", err)
			}
			ids = rows

		case "unread":
			rows, err := queries.DashboardUnreadBooks(ctx, sqlc.DashboardUnreadBooksParams{
				IsAdmin: adminFlag(viewer),
				UserID:  viewer.UserID,
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list unread books: %w", err)
			}
			ids = rows

		case "want_to_read":
			rows, err := queries.DashboardWantToReadBooks(ctx, sqlc.DashboardWantToReadBooksParams{
				IsAdmin: adminFlag(viewer),
				UserID:  viewer.UserID,
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list want to read books: %w", err)
			}
			ids = rows
		}

		// Handle cursor pagination by ID
		if after.ID != 0 {
			index := slices.Index(ids, after.ID)
			if index < 0 {
				return Page[Book]{}, invalid("cursor is invalid")
			}
			ids = ids[index+1:]
		}

		ids, next, err := paginate(ids, limit, func(id int64) cursor {
			return cursor{
				Version: 1, Kind: "dashboard_books", Scope: scope, Sort: section, ID: id,
			}
		})
		if err != nil {
			return Page[Book]{}, err
		}

		// Hydrate books
		items := make([]Book, 0, len(ids))
		for _, id := range ids {
			row, err := visibleBook(ctx, queries, viewer, id)
			if err != nil {
				return Page[Book]{}, err
			}
			book, err := hydrateBook(ctx, queries, viewer, row)
			if err != nil {
				return Page[Book]{}, err
			}
			items = append(items, book)
		}

		return Page[Book]{Items: items, NextCursor: next}, nil
	})
}
