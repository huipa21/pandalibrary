package catalog

import (
	"context"
	"database/sql"
	"fmt"
	"path"
	"strings"
	"unicode"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/db/sqlc"
)

// fileBaseName returns the stored original filename without any directory or
// drive prefix, falling back to "<title>.<format>" when nothing usable remains.
func fileBaseName(stored, title, format string) string {
	name := strings.ReplaceAll(strings.TrimSpace(stripControl(stored)), `\`, "/")
	if len(name) >= 2 && name[1] == ':' && isASCIILetter(name[0]) {
		name = name[2:]
	}
	name = strings.TrimRight(name, "/")
	if name != "" {
		name = path.Base(name)
	}
	if name == "" || name == "." || name == ".." || name == "/" {
		safeTitle := strings.NewReplacer("/", "_", `\`, "_").Replace(strings.TrimSpace(stripControl(title)))
		if safeTitle == "" {
			safeTitle = "book"
		}
		return safeTitle + "." + format
	}
	return name
}

func isASCIILetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func stripControl(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return '_'
		}
		return r
	}, value)
}

func libraryDTO(row sqlc.Library) Library {
	return Library{
		ID: row.ID, Name: row.Name, Slug: row.Slug,
		CreatedAt: utcMillis(row.CreatedAt), UpdatedAt: utcMillis(row.UpdatedAt),
	}
}

// ListLibraries returns libraries visible to the viewer, including empty libraries.
func (s *Service) ListLibraries(ctx context.Context, viewer Viewer, options PageOptions) (Page[Library], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Library]{}, err
	}
	scope := viewerScope(viewer)
	limit, after, err := parsePage(options, "libraries", scope, "")
	if err != nil {
		return Page[Library]{}, err
	}
	rows, err := sqlc.New(s.reader).CatalogListLibraries(ctx, sqlc.CatalogListLibrariesParams{
		IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
		AfterID: after.ID, AfterName: after.Text, PageSize: int64(limit + 1),
	})
	if err != nil {
		return Page[Library]{}, fmt.Errorf("list libraries: %w", err)
	}
	rows, next, err := paginate(rows, limit, func(row sqlc.Library) cursor {
		return cursor{Version: 1, Kind: "libraries", Scope: scope, ID: row.ID, Text: row.Name}
	})
	if err != nil {
		return Page[Library]{}, err
	}
	items := make([]Library, 0, len(rows))
	for _, row := range rows {
		items = append(items, libraryDTO(row))
	}
	return Page[Library]{Items: items, NextCursor: next}, nil
}

// GetLibrary returns a library only when the viewer has access to it.
func (s *Service) GetLibrary(ctx context.Context, viewer Viewer, id int64) (Library, error) {
	if err := checkViewer(viewer); err != nil {
		return Library{}, err
	}
	if id < 1 {
		return Library{}, invalid("library ID is invalid")
	}
	row, err := sqlc.New(s.reader).CatalogGetLibrary(ctx, sqlc.CatalogGetLibraryParams{
		LibraryID: id, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return Library{}, notFound(fmt.Errorf("get library: %w", err))
	}
	return libraryDTO(row), nil
}

// ListBooks returns a visibility-filtered, keyset-paginated catalog.
func (s *Service) ListBooks(ctx context.Context, viewer Viewer, filters BookFilters, options PageOptions) (Page[Book], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Book]{}, err
	}
	if filters.LibraryID < 0 || filters.AuthorID < 0 || filters.SeriesID < 0 || filters.TagID < 0 {
		return Page[Book]{}, invalid("book filter IDs must be positive")
	}
	if filters.Sort == "" {
		filters.Sort = "title"
	}
	if filters.Sort != "title" && filters.Sort != "added" && filters.Sort != "series" {
		return Page[Book]{}, invalid("book sort is invalid")
	}
	if filters.Sort == "series" && filters.SeriesID == 0 {
		return Page[Book]{}, invalid("series sorting requires a series filter")
	}
	scope := fmt.Sprintf("%s:%d:%d:%d:%d", viewerScope(viewer),
		filters.LibraryID, filters.AuthorID, filters.SeriesID, filters.TagID)
	limit, after, err := parsePage(options, "books", scope, filters.Sort)
	if err != nil {
		return Page[Book]{}, err
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[Book], error) {
		var rows []sqlc.Book
		var err error
		switch filters.Sort {
		case "title":
			rows, err = queries.CatalogListBooksByTitle(ctx, sqlc.CatalogListBooksByTitleParams{
				IsAdmin: adminFlag(viewer), UserID: viewer.UserID, LibraryID: filters.LibraryID,
				AuthorID: filters.AuthorID, SeriesID: filters.SeriesID, TagID: filters.TagID,
				AfterID: after.ID, AfterTitle: after.Text, PageSize: int64(limit + 1),
			})
		case "added":
			rows, err = queries.CatalogListBooksByAdded(ctx, sqlc.CatalogListBooksByAddedParams{
				IsAdmin: adminFlag(viewer), UserID: viewer.UserID, LibraryID: filters.LibraryID,
				AuthorID: filters.AuthorID, SeriesID: filters.SeriesID, TagID: filters.TagID,
				AfterID: after.ID, AfterCreatedAt: after.Time, PageSize: int64(limit + 1),
			})
		case "series":
			afterNull := int64(0)
			if after.Null {
				afterNull = 1
			}
			rows, err = queries.CatalogListBooksBySeries(ctx, sqlc.CatalogListBooksBySeriesParams{
				IsAdmin: adminFlag(viewer), UserID: viewer.UserID, LibraryID: filters.LibraryID,
				AuthorID: filters.AuthorID, SeriesID: sql.NullInt64{Int64: filters.SeriesID, Valid: true},
				TagID: filters.TagID, AfterID: after.ID, AfterNull: afterNull,
				AfterIndex: after.Index, PageSize: int64(limit + 1),
			})
		}
		if err != nil {
			return Page[Book]{}, fmt.Errorf("list books: %w", err)
		}
		rows, next, err := paginate(rows, limit, func(row sqlc.Book) cursor {
			return cursor{
				Version: 1, Kind: "books", Scope: scope, Sort: filters.Sort, ID: row.ID,
				Text: row.SortTitle, Time: row.CreatedAt, Index: row.SeriesIndex.Float64,
				Null: !row.SeriesIndex.Valid,
			}
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
	})
}

// CountBooks returns the number of books visible to the viewer across all libraries.
func (s *Service) CountBooks(ctx context.Context, viewer Viewer) (int64, error) {
	if err := checkViewer(viewer); err != nil {
		return 0, err
	}
	count, err := readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (int64, error) {
		return queries.CatalogVisibleBookCount(ctx, sqlc.CatalogVisibleBookCountParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
		})
	})
	if err != nil {
		return 0, fmt.Errorf("count books: %w", err)
	}
	return count, nil
}

// GetBook returns a visible book and its related catalog data.
func (s *Service) GetBook(ctx context.Context, viewer Viewer, id int64) (Book, error) {
	if err := checkViewer(viewer); err != nil {
		return Book{}, err
	}
	if id < 1 {
		return Book{}, invalid("book ID is invalid")
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Book, error) {
		row, err := visibleBook(ctx, queries, viewer, id)
		if err != nil {
			return Book{}, err
		}
		return hydrateBook(ctx, queries, viewer, row)
	})
}

func visibleBook(ctx context.Context, queries *sqlc.Queries, viewer Viewer, id int64) (sqlc.Book, error) {
	row, err := queries.CatalogGetBook(ctx, sqlc.CatalogGetBookParams{
		BookID: id, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return sqlc.Book{}, notFound(fmt.Errorf("get visible book: %w", err))
	}
	return row, nil
}

func hydrateBook(ctx context.Context, queries *sqlc.Queries, viewer Viewer, row sqlc.Book) (Book, error) {
	book := Book{
		ID: row.ID, LibraryID: row.LibraryID, Title: row.Title, SortTitle: row.SortTitle,
		OwnerID: intPointer(row.OwnerID), Visibility: row.Visibility,
		CanManageVisibility: row.OwnerID.Valid && row.OwnerID.Int64 == viewer.UserID,
		Subtitle:            stringPointer(row.Subtitle), Description: stringPointer(row.Description),
		Language: stringPointer(row.Language), Publisher: stringPointer(row.Publisher),
		PublishedDate: stringPointer(row.PublishedDate), PageCount: intPointer(row.PageCount),
		CoverSource: stringPointer(row.CoverSource), Authors: []Author{}, Tags: []Tag{},
		Identifiers: []Identifier{}, Files: []BookFile{}, FieldSources: []FieldSource{},
		CreatedAt: utcMillis(row.CreatedAt), UpdatedAt: utcMillis(row.UpdatedAt),
	}
	if row.CoverSha256.Valid {
		if !blobstore.ValidHash(row.CoverSha256.String) {
			return Book{}, fmt.Errorf("book %d has an invalid cover hash", row.ID)
		}
		url := fmt.Sprintf("/api/v1/books/%d/cover", row.ID)
		book.CoverURL = &url
	}
	authors, err := queries.CatalogBookAuthors(ctx, sqlc.CatalogBookAuthorsParams{
		BookID: row.ID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return Book{}, fmt.Errorf("load book authors: %w", err)
	}
	for _, author := range authors {
		book.Authors = append(book.Authors, Author{
			ID: author.ID, Name: author.Name, Role: author.Role, Position: author.Position,
		})
	}
	if row.SeriesID.Valid {
		series, err := queries.CatalogBookSeries(ctx, sqlc.CatalogBookSeriesParams{
			BookID: row.ID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
		})
		if err != nil {
			return Book{}, fmt.Errorf("load book series: %w", err)
		}
		book.Series = &Series{ID: series.ID, Name: series.Name, Index: floatPointer(series.SeriesIndex)}
	}
	tags, err := queries.CatalogBookTags(ctx, sqlc.CatalogBookTagsParams{
		BookID: row.ID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return Book{}, fmt.Errorf("load book tags: %w", err)
	}
	for _, tag := range tags {
		book.Tags = append(book.Tags, Tag{ID: tag.ID, Name: tag.Name})
	}
	identifiers, err := queries.CatalogBookIdentifiers(ctx, sqlc.CatalogBookIdentifiersParams{
		BookID: row.ID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return Book{}, fmt.Errorf("load book identifiers: %w", err)
	}
	for _, identifier := range identifiers {
		book.Identifiers = append(book.Identifiers, Identifier{Scheme: identifier.Scheme, Value: identifier.Value})
	}
	files, err := queries.CatalogBookFiles(ctx, sqlc.CatalogBookFilesParams{
		BookID: row.ID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return Book{}, fmt.Errorf("load book files: %w", err)
	}
	for _, file := range files {
		if _, err := blobstore.BookPath(file.Sha256, file.Format); err != nil {
			return Book{}, fmt.Errorf("book %d has an invalid file key: %w", row.ID, err)
		}
		book.Files = append(book.Files, BookFile{
			ID: file.ID, Format: file.Format, SizeBytes: file.SizeBytes,
			DownloadURL:      fmt.Sprintf("/api/v1/books/%d/files/%d?v=%s", row.ID, file.ID, file.Sha256),
			OriginalFilename: fileBaseName(file.OriginalFilename, row.Title, file.Format),
			CreatedAt:        utcMillis(file.CreatedAt),
		})
	}
	sources, err := queries.CatalogBookFieldSources(ctx, sqlc.CatalogBookFieldSourcesParams{
		BookID: row.ID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return Book{}, fmt.Errorf("load book field sources: %w", err)
	}
	for _, source := range sources {
		book.FieldSources = append(book.FieldSources, FieldSource{
			Field: source.Field, Source: source.Source, SourceRef: stringPointer(source.SourceRef),
			ChosenBy: intPointer(source.ChosenBy), ChosenAt: utcMillis(source.ChosenAt),
		})
	}
	return book, nil
}

type entityRow struct {
	entity  Entity
	sortKey string
}

// ListEntities lists authors, series, or tags associated with visible books.
func (s *Service) ListEntities(ctx context.Context, viewer Viewer, kind string, options PageOptions) (Page[Entity], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Entity]{}, err
	}
	if kind != "authors" && kind != "series" && kind != "tags" {
		return Page[Entity]{}, invalid("catalog entity kind is invalid")
	}
	scope := viewerScope(viewer)
	limit, after, err := parsePage(options, kind, scope, "")
	if err != nil {
		return Page[Entity]{}, err
	}
	queries := sqlc.New(s.reader)
	rows := make([]entityRow, 0, limit+1)
	switch kind {
	case "authors":
		found, err := queries.CatalogListAuthors(ctx, sqlc.CatalogListAuthorsParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
			AfterID: after.ID, AfterName: after.Text, PageSize: int64(limit + 1),
		})
		if err != nil {
			return Page[Entity]{}, fmt.Errorf("list authors: %w", err)
		}
		for _, row := range found {
			rows = append(rows, entityRow{
				entity:  Entity{ID: row.ID, Name: row.Name, VisibleBookCount: row.VisibleBookCount},
				sortKey: row.SortName,
			})
		}
	case "series":
		found, err := queries.CatalogListSeries(ctx, sqlc.CatalogListSeriesParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
			AfterID: after.ID, AfterName: after.Text, PageSize: int64(limit + 1),
		})
		if err != nil {
			return Page[Entity]{}, fmt.Errorf("list series: %w", err)
		}
		for _, row := range found {
			rows = append(rows, entityRow{
				entity:  Entity{ID: row.ID, Name: row.Name, Description: stringPointer(row.Description), VisibleBookCount: row.VisibleBookCount},
				sortKey: row.Name,
			})
		}
	case "tags":
		found, err := queries.CatalogListTags(ctx, sqlc.CatalogListTagsParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
			AfterID: after.ID, AfterName: after.Text, PageSize: int64(limit + 1),
		})
		if err != nil {
			return Page[Entity]{}, fmt.Errorf("list tags: %w", err)
		}
		for _, row := range found {
			rows = append(rows, entityRow{
				entity:  Entity{ID: row.ID, Name: row.Name, VisibleBookCount: row.VisibleBookCount},
				sortKey: row.Name,
			})
		}
	}
	rows, next, err := paginate(rows, limit, func(row entityRow) cursor {
		return cursor{Version: 1, Kind: kind, Scope: scope, ID: row.entity.ID, Text: row.sortKey}
	})
	if err != nil {
		return Page[Entity]{}, err
	}
	items := make([]Entity, 0, len(rows))
	for _, row := range rows {
		items = append(items, row.entity)
	}
	return Page[Entity]{Items: items, NextCursor: next}, nil
}

// GetEntity returns an author, series, or tag only when it has a visible book.
func (s *Service) GetEntity(ctx context.Context, viewer Viewer, kind string, id int64) (Entity, error) {
	if err := checkViewer(viewer); err != nil {
		return Entity{}, err
	}
	if id < 1 {
		return Entity{}, invalid("catalog entity ID is invalid")
	}
	queries := sqlc.New(s.reader)
	switch kind {
	case "authors":
		row, err := queries.CatalogGetAuthor(ctx, sqlc.CatalogGetAuthorParams{
			AuthorID: id, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
		})
		if err != nil {
			return Entity{}, notFound(fmt.Errorf("get author: %w", err))
		}
		return Entity{ID: row.ID, Name: row.Name, VisibleBookCount: row.VisibleBookCount}, nil
	case "series":
		row, err := queries.CatalogGetSeries(ctx, sqlc.CatalogGetSeriesParams{
			SeriesID: id, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
		})
		if err != nil {
			return Entity{}, notFound(fmt.Errorf("get series: %w", err))
		}
		return Entity{ID: row.ID, Name: row.Name, Description: stringPointer(row.Description), VisibleBookCount: row.VisibleBookCount}, nil
	case "tags":
		row, err := queries.CatalogGetTag(ctx, sqlc.CatalogGetTagParams{
			TagID: id, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
		})
		if err != nil {
			return Entity{}, notFound(fmt.Errorf("get tag: %w", err))
		}
		return Entity{ID: row.ID, Name: row.Name, VisibleBookCount: row.VisibleBookCount}, nil
	default:
		return Entity{}, invalid("catalog entity kind is invalid")
	}
}
