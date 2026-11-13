package catalog

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"slices"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

func shelfOrderSignature(ids []int64) string {
	hash := sha256.New()
	var encoded [8]byte
	for _, id := range ids {
		binary.BigEndian.PutUint64(encoded[:], uint64(id))
		_, _ = hash.Write(encoded[:])
	}
	return base64.RawURLEncoding.EncodeToString(hash.Sum(nil))
}

// ListShelfBooks returns visible, fully hydrated books. Rule-free manual shelves use manual
// order and a cursor that is invalidated if the viewer's visible membership or order
// changes. Collections with rules (and legacy automatic shelves) are evaluated live
// and ordered by sort title and ID; their cursors are bound to the current groups.
// An optional positive library ID intersects
// membership with that accessible library and binds cursors to that scope.
func (s *Service) ListShelfBooks(ctx context.Context, viewer Viewer, shelfID int64, options PageOptions, libraryIDs ...int64) (Page[Book], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Book]{}, err
	}
	if shelfID < 1 {
		return Page[Book]{}, invalid("shelf ID is invalid")
	}
	if options.Limit != 0 && (options.Limit < 1 || options.Limit > maximumPageSize) {
		return Page[Book]{}, invalid("limit must be between 1 and 100")
	}
	libraryID, err := shelfLibraryID(libraryIDs)
	if err != nil {
		return Page[Book]{}, err
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[Book], error) {
		if err := checkShelfLibrary(ctx, queries, viewer, libraryID); err != nil {
			return Page[Book]{}, err
		}
		shelf, err := shelfForViewer(ctx, queries, viewer, shelfID)
		if err != nil {
			return Page[Book]{}, err
		}
		if shelf.Mode == ShelfModeAutomatic || shelf.RuleGroups != "[]" {
			return listAutomaticShelfBooks(ctx, queries, viewer, shelf, options, libraryID)
		}
		return listManualShelfBooks(ctx, queries, viewer, shelfID, options, libraryID)
	})
}

// ListShelfBooksFiltered browses a shelf using the catalog's filters and sorting.
func (s *Service) ListShelfBooksFiltered(ctx context.Context, viewer Viewer, shelfID int64, filters BookFilters, options PageOptions) (Page[Book], error) {
	return s.listShelfBooksFiltered(ctx, viewer, shelfID, filters, options, "shelf_browse_books")
}

func (s *Service) listShelfBooksFiltered(ctx context.Context, viewer Viewer, shelfID int64, filters BookFilters, options PageOptions, kind string) (Page[Book], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Book]{}, err
	}
	if shelfID < 1 {
		return Page[Book]{}, invalid("shelf ID is invalid")
	}
	filters, err := normalizeBookFilters(filters)
	if err != nil {
		return Page[Book]{}, err
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[Book], error) {
		if err := checkShelfLibrary(ctx, queries, viewer, filters.LibraryID); err != nil {
			return Page[Book]{}, err
		}
		shelf, err := shelfForViewer(ctx, queries, viewer, shelfID)
		if err != nil {
			return Page[Book]{}, err
		}
		ids, err := queries.ShelfVisibleBookIDs(ctx, sqlc.ShelfVisibleBookIDsParams{
			ShelfID: shelf.ID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID, LibraryID: filters.LibraryID,
		})
		if err != nil {
			return Page[Book]{}, fmt.Errorf("load visible shelf membership: %w", err)
		}
		scope := fmt.Sprintf("%s:shelf:%d:rules:%s:members:%s", bookFilterScope(viewer, filters), shelf.ID,
			rulesSignature(shelf.RuleGroups), shelfOrderSignature(ids))
		limit, after, err := parsePage(options, kind, scope, filters.Sort)
		if err != nil {
			return Page[Book]{}, err
		}
		afterNull := int64(0)
		if after.Null {
			afterNull = 1
		}
		rows, err := queries.ShelfAutomaticBooks(ctx, sqlc.ShelfAutomaticBooksParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID, RuleGroups: shelf.RuleGroups, ShelfID: shelf.ID,
			LibraryID: filters.LibraryID, AuthorID: filters.AuthorID, SeriesID: filters.SeriesID, TagID: filters.TagID,
			SortMode: filters.Sort, AfterID: after.ID, AfterTitle: after.Text, AfterCreatedAt: after.Time,
			AfterNull: afterNull, AfterIndex: after.Index, PageSize: int64(limit + 1),
		})
		if err != nil {
			return Page[Book]{}, fmt.Errorf("browse shelf books: %w", err)
		}
		return browseBookPage(ctx, queries, viewer, rows, limit, kind, scope, filters.Sort)
	})
}

func listManualShelfBooks(ctx context.Context, queries *sqlc.Queries, viewer Viewer, shelfID int64, options PageOptions, libraryID int64) (Page[Book], error) {
	scope := shelfLibraryScope(fmt.Sprintf("%s:%d", viewerScope(viewer), shelfID), libraryID)
	limit, after, err := parsePage(options, "shelf_books", scope, "manual")
	if err != nil {
		return Page[Book]{}, err
	}
	ids, err := queries.ShelfVisibleBookIDs(ctx, sqlc.ShelfVisibleBookIDsParams{
		ShelfID: shelfID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID, LibraryID: libraryID,
	})
	if err != nil {
		return Page[Book]{}, fmt.Errorf("list visible shelf books: %w", err)
	}
	// Avoid exposing raw positions while detecting changes that could skip or repeat books.
	signature := shelfOrderSignature(ids)
	if after.ID != 0 {
		if after.Text != signature {
			return Page[Book]{}, invalid("shelf order has changed; restart pagination")
		}
		index := slices.Index(ids, after.ID)
		if index < 0 {
			return Page[Book]{}, invalid("cursor is invalid")
		}
		ids = ids[index+1:]
	}
	ids, next, err := paginate(ids, limit, func(id int64) cursor {
		return cursor{
			Version: 1, Kind: "shelf_books", Scope: scope, Sort: "manual", ID: id, Text: signature,
		}
	})
	if err != nil {
		return Page[Book]{}, err
	}
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
}

func listAutomaticShelfBooks(ctx context.Context, queries *sqlc.Queries, viewer Viewer, shelf sqlc.Shelf, options PageOptions, libraryID int64) (Page[Book], error) {
	scope := shelfLibraryScope(fmt.Sprintf("%s:%d:automatic:%s", viewerScope(viewer), shelf.ID, rulesSignature(shelf.RuleGroups)), libraryID)
	limit, after, err := parsePage(options, "shelf_books", scope, "title")
	if err != nil {
		return Page[Book]{}, err
	}
	rows, err := queries.ShelfAutomaticBooks(ctx, sqlc.ShelfAutomaticBooksParams{
		IsAdmin: adminFlag(viewer), UserID: viewer.UserID, RuleGroups: shelf.RuleGroups, ShelfID: shelf.ID, LibraryID: libraryID,
		SortMode: "title", AfterID: after.ID, AfterTitle: after.Text, PageSize: int64(limit + 1),
	})
	if err != nil {
		return Page[Book]{}, fmt.Errorf("list automatic shelf books: %w", err)
	}
	return titlePage(ctx, queries, viewer, rows, limit, "shelf_books", scope)
}

// titlePage hydrates a sort-title/ID keyset page fetched with limit+1 rows.
func titlePage(ctx context.Context, queries *sqlc.Queries, viewer Viewer, rows []sqlc.Book, limit int, kind, scope string) (Page[Book], error) {
	rows, next, err := paginate(rows, limit, func(row sqlc.Book) cursor {
		return cursor{Version: 1, Kind: kind, Scope: scope, Sort: "title", ID: row.ID, Text: row.SortTitle}
	})
	if err != nil {
		return Page[Book]{}, err
	}
	items := make([]Book, 0, len(rows))
	for _, row := range rows {
		book, err := hydrateBook(ctx, queries, viewer, row)
		if err != nil {
			return Page[Book]{}, err
		}
		items = append(items, book)
	}
	return Page[Book]{Items: items, NextCursor: next}, nil
}

func orderedShelfMembers(ctx context.Context, queries *sqlc.Queries, viewer Viewer, shelfID int64) ([]sqlc.ShelfOrderedMembersRow, error) {
	members, err := queries.ShelfOrderedMembers(ctx, sqlc.ShelfOrderedMembersParams{
		ShelfID: shelfID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return nil, fmt.Errorf("load shelf order: %w", err)
	}
	return members, nil
}

func saveShelfOrder(ctx context.Context, queries *sqlc.Queries, shelfID int64, members []sqlc.ShelfOrderedMembersRow) (bool, error) {
	changed := false
	for index, member := range members {
		position := int64(index)
		if member.Position == position {
			continue
		}
		if err := queries.ShelfUpdateBookPosition(ctx, sqlc.ShelfUpdateBookPositionParams{
			ShelfID: shelfID, BookID: member.BookID, Position: position,
		}); err != nil {
			return false, fmt.Errorf("update shelf order: %w", err)
		}
		changed = true
	}
	return changed, nil
}

func touchShelf(ctx context.Context, queries *sqlc.Queries, shelfID, now int64, changed bool) error {
	if !changed {
		return nil
	}
	if err := queries.ShelfTouch(ctx, sqlc.ShelfTouchParams{ID: shelfID, UpdatedAt: now}); err != nil {
		return fmt.Errorf("update shelf timestamp: %w", err)
	}
	return nil
}

// PutShelfBook adds a visible book or moves an existing member. Position is a
// zero-based visible index; nil appends a new member and leaves existing members in place.
func (s *Service) PutShelfBook(ctx context.Context, viewer Viewer, shelfID, bookID int64, position *int64) error {
	if err := checkViewer(viewer); err != nil {
		return err
	}
	if shelfID < 1 || bookID < 1 || position != nil && *position < 0 {
		return invalid("shelf and book IDs must be positive and position must be nonnegative")
	}
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		shelf, err := shelfForViewer(ctx, queries, viewer, shelfID)
		if err != nil {
			return err
		}
		if err := checkShelfManager(viewer, shelf); err != nil {
			return err
		}
		return putShelfBook(ctx, queries, viewer, shelfID, bookID, position, s.now().UnixMilli())
	})
}

// putShelfBook adds or moves a visible book on a shelf the caller already authorized.
func putShelfBook(ctx context.Context, queries *sqlc.Queries, viewer Viewer, shelfID, bookID int64, position *int64, now int64) error {
	if _, err := visibleBook(ctx, queries, viewer, bookID); err != nil {
		return err
	}
	members, err := orderedShelfMembers(ctx, queries, viewer, shelfID)
	if err != nil {
		return err
	}
	memberIndex, visibleIndex, visibleCount := -1, -1, 0
	for index, member := range members {
		if member.BookID == bookID {
			memberIndex, visibleIndex = index, visibleCount
		}
		if member.IsVisible != 0 {
			visibleCount++
		}
	}
	if memberIndex >= 0 && position == nil {
		changed, err := saveShelfOrder(ctx, queries, shelfID, members)
		if err != nil {
			return err
		}
		return touchShelf(ctx, queries, shelfID, now, changed)
	}
	desired := visibleCount
	if memberIndex >= 0 {
		desired--
	}
	if position != nil && *position < int64(desired) {
		desired = int(*position)
	}
	if memberIndex >= 0 && visibleIndex == desired {
		changed, err := saveShelfOrder(ctx, queries, shelfID, members)
		if err != nil {
			return err
		}
		return touchShelf(ctx, queries, shelfID, now, changed)
	}
	member := sqlc.ShelfOrderedMembersRow{BookID: bookID, IsVisible: 1}
	if memberIndex >= 0 {
		member = members[memberIndex]
		members = append(members[:memberIndex], members[memberIndex+1:]...)
	}
	insertAt, visible := len(members), 0
	for index, existing := range members {
		if existing.IsVisible == 0 {
			continue
		}
		if visible == desired {
			insertAt = index
			break
		}
		visible++
	}
	members = append(members, sqlc.ShelfOrderedMembersRow{})
	copy(members[insertAt+1:], members[insertAt:])
	members[insertAt] = member
	if memberIndex < 0 {
		if err := queries.ShelfInsertBook(ctx, sqlc.ShelfInsertBookParams{
			ShelfID: shelfID, BookID: bookID, Position: int64(insertAt),
			AddedBy: sql.NullInt64{Int64: viewer.UserID, Valid: true}, AddedAt: now,
		}); err != nil {
			return fmt.Errorf("add shelf book: %w", err)
		}
		members[insertAt].Position = int64(insertAt)
	}
	changed, err := saveShelfOrder(ctx, queries, shelfID, members)
	if err != nil {
		return err
	}
	return touchShelf(ctx, queries, shelfID, now, changed || memberIndex < 0)
}

// RemoveShelfBook idempotently removes manual provenance for a visible book from
// a managed shelf. Matching rule groups may still include the book.
func (s *Service) RemoveShelfBook(ctx context.Context, viewer Viewer, shelfID, bookID int64) error {
	if err := checkViewer(viewer); err != nil {
		return err
	}
	if shelfID < 1 || bookID < 1 {
		return invalid("shelf and book IDs must be positive")
	}
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		shelf, err := shelfForViewer(ctx, queries, viewer, shelfID)
		if err != nil {
			return err
		}
		if err := checkShelfManager(viewer, shelf); err != nil {
			return err
		}
		if _, err := visibleBook(ctx, queries, viewer, bookID); err != nil {
			return err
		}
		members, err := orderedShelfMembers(ctx, queries, viewer, shelfID)
		if err != nil {
			return err
		}
		deleted, err := queries.ShelfRemoveBook(ctx, sqlc.ShelfRemoveBookParams{ShelfID: shelfID, BookID: bookID})
		if err != nil {
			return fmt.Errorf("remove shelf book: %w", err)
		}
		if deleted != 0 {
			for index, member := range members {
				if member.BookID == bookID {
					members = append(members[:index], members[index+1:]...)
					break
				}
			}
		}
		changed, err := saveShelfOrder(ctx, queries, shelfID, members)
		if err != nil {
			return err
		}
		return touchShelf(ctx, queries, shelfID, s.now().UnixMilli(), changed || deleted != 0)
	})
}
