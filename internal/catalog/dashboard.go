package catalog

import (
	"context"
	"fmt"

	"pandalibrary/internal/db/sqlc"
)

type dashboardPosition struct {
	id       int64
	sortTime int64
	title    string
}

// ListDashboardBooks returns a visibility-filtered, keyset-paginated feed of books for a dashboard section.
// Supported sections: continue_reading, recently_added, read, unread, want_to_read.
func (s *Service) ListDashboardBooks(ctx context.Context, viewer Viewer, section string, options PageOptions) (Page[Book], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Book]{}, err
	}

	switch section {
	case "continue_reading", "recently_added", "read", "unread", "want_to_read":
	default:
		return Page[Book]{}, invalid(fmt.Sprintf("dashboard section %q is not supported", section))
	}

	if options.Limit == 0 {
		options.Limit = 20
	}
	scope := fmt.Sprintf("%s:%s", viewerScope(viewer), section)
	limit, after, err := parsePage(options, "dashboard_books_v2", scope, section)
	if err != nil {
		return Page[Book]{}, err
	}

	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[Book], error) {
		positions := make([]dashboardPosition, 0, limit+1)
		switch section {
		case "continue_reading":
			rows, err := queries.DashboardContinueReadingBooks(ctx, sqlc.DashboardContinueReadingBooksParams{
				IsAdmin: adminFlag(viewer), UserID: viewer.UserID, AfterID: after.ID,
				AfterTime: after.Time, PageSize: int64(limit + 1),
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list continue reading books: %w", err)
			}
			for _, row := range rows {
				positions = append(positions, dashboardPosition{id: row.ID, sortTime: row.SortTime})
			}

		case "recently_added":
			rows, err := queries.DashboardRecentlyAddedBooks(ctx, sqlc.DashboardRecentlyAddedBooksParams{
				IsAdmin: adminFlag(viewer), UserID: viewer.UserID, AfterID: after.ID,
				AfterTime: after.Time, PageSize: int64(limit + 1),
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list recently added books: %w", err)
			}
			for _, row := range rows {
				positions = append(positions, dashboardPosition{id: row.ID, sortTime: row.SortTime})
			}

		case "read":
			rows, err := queries.DashboardReadBooks(ctx, sqlc.DashboardReadBooksParams{
				IsAdmin: adminFlag(viewer), UserID: viewer.UserID, AfterID: after.ID,
				AfterTime: after.Time, PageSize: int64(limit + 1),
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list read books: %w", err)
			}
			for _, row := range rows {
				positions = append(positions, dashboardPosition{id: row.ID, sortTime: row.SortTime})
			}

		case "unread":
			rows, err := queries.DashboardUnreadBooks(ctx, sqlc.DashboardUnreadBooksParams{
				IsAdmin: adminFlag(viewer), UserID: viewer.UserID, AfterID: after.ID,
				AfterTitle: after.Text, PageSize: int64(limit + 1),
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list unread books: %w", err)
			}
			for _, row := range rows {
				positions = append(positions, dashboardPosition{id: row.ID, title: row.SortTitle})
			}

		case "want_to_read":
			rows, err := queries.DashboardWantToReadBooks(ctx, sqlc.DashboardWantToReadBooksParams{
				IsAdmin: adminFlag(viewer), UserID: viewer.UserID, AfterID: after.ID,
				AfterTime: after.Time, PageSize: int64(limit + 1),
			})
			if err != nil {
				return Page[Book]{}, fmt.Errorf("list want to read books: %w", err)
			}
			for _, row := range rows {
				positions = append(positions, dashboardPosition{id: row.ID, sortTime: row.SortTime})
			}
		}

		positions, next, err := paginate(positions, limit, func(position dashboardPosition) cursor {
			return cursor{
				Version: 1, Kind: "dashboard_books_v2", Scope: scope, Sort: section,
				ID: position.id, Time: position.sortTime, Text: position.title,
			}
		})
		if err != nil {
			return Page[Book]{}, err
		}

		items := make([]Book, 0, len(positions))
		for _, position := range positions {
			row, err := visibleBook(ctx, queries, viewer, position.id)
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
