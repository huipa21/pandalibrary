package catalog

import (
	"context"
	"database/sql"
	"fmt"

	"pandalibrary/internal/covers"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/search"
)

// UpdateBook applies a validated metadata patch atomically to a visible book.
func (s *Service) UpdateBook(ctx context.Context, viewer Viewer, id int64, patch BookPatch) (Book, error) {
	return s.updateBook(ctx, viewer, id, patch, nil, nil)
}

func (s *Service) updateBook(ctx context.Context, viewer Viewer, id int64, patch BookPatch, sources map[string]MetadataSource, cover *covers.Result) (Book, error) {
	return s.updateBookWithManualPatch(ctx, viewer, id, patch, sources, cover, BookPatch{})
}

func (s *Service) updateBookWithManualPatch(ctx context.Context, viewer Viewer, id int64, patch BookPatch, sources map[string]MetadataSource, cover *covers.Result, manual BookPatch) (Book, error) {
	if err := checkAdmin(viewer); err != nil {
		return Book{}, err
	}
	if id < 1 {
		return Book{}, invalid("book ID is invalid")
	}
	patch, fields, err := normalizeBookPatch(patch, cover != nil)
	if err != nil {
		return Book{}, err
	}
	if sources != nil {
		if patch.LibraryID.Set || manual.LibraryID.Set {
			return Book{}, invalid("provider metadata cannot move books")
		}
		expected := append([]string(nil), fields...)
		if cover != nil {
			expected = append(expected, "cover")
		}
		if len(sources) != len(expected) {
			return Book{}, invalid("each selected field requires provenance")
		}
		for _, field := range expected {
			source, ok := sources[field]
			if !ok || !validMetadataSource(source) {
				return Book{}, invalid("provider provenance is invalid")
			}
		}
		// Validate provider provenance against the provider patch before merging.
		manual, manualFields, err := normalizeBookPatch(manual, true)
		if err != nil {
			return Book{}, err
		}
		for _, field := range manualFields {
			if _, selected := sources[field]; selected {
				return Book{}, invalid("manual and provider fields overlap: " + field)
			}
		}
		patch = mergeManualPatch(patch, manual)
		fields = append(fields, manualFields...)
	}
	if cover != nil {
		if err := s.blobs.PublishCover(cover.FullSHA256, cover.FullJPEG, cover.ThumbnailJPEG); err != nil {
			return Book{}, fmt.Errorf("publish provider cover: %w", err)
		}
	}
	var result Book
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		row, err := visibleBook(ctx, queries, viewer, id)
		if err != nil {
			return err
		}
		now := s.now().UnixMilli()
		if patch.LibraryID.Set {
			if _, err := libraryInTx(ctx, queries, viewer, *patch.LibraryID.Value); err != nil {
				return err
			}
			row.LibraryID = *patch.LibraryID.Value
		}
		if patch.Title.Set {
			row.Title = *patch.Title.Value
			row.SortTitle = SortTitle(row.Title)
		}
		for _, field := range []struct {
			input Optional[string]
			dest  *sql.NullString
		}{
			{patch.Subtitle, &row.Subtitle},
			{patch.Description, &row.Description},
			{patch.Language, &row.Language},
			{patch.Publisher, &row.Publisher},
			{patch.PublishedDate, &row.PublishedDate},
		} {
			if field.input.Set {
				field.dest.Valid = field.input.Value != nil
				field.dest.String = ""
				if field.input.Value != nil {
					field.dest.String = *field.input.Value
				}
			}
		}
		if patch.PageCount.Set {
			row.PageCount = sql.NullInt64{}
			if patch.PageCount.Value != nil {
				row.PageCount = sql.NullInt64{Int64: *patch.PageCount.Value, Valid: true}
			}
		}
		if patch.Series.Set {
			row.SeriesID = sql.NullInt64{}
			row.SeriesIndex = sql.NullFloat64{}
			if patch.Series.Value != nil {
				if err := queries.CatalogInsertSeries(ctx, sqlc.CatalogInsertSeriesParams{
					Name: patch.Series.Value.Name, CreatedAt: now,
				}); err != nil {
					return fmt.Errorf("create series: %w", err)
				}
				seriesID, err := queries.CatalogSeriesByName(ctx, patch.Series.Value.Name)
				if err != nil {
					return fmt.Errorf("find series: %w", err)
				}
				row.SeriesID = sql.NullInt64{Int64: seriesID, Valid: true}
				if patch.Series.Value.Index != nil {
					row.SeriesIndex = sql.NullFloat64{Float64: *patch.Series.Value.Index, Valid: true}
				}
			}
		}
		if patch.Authors.Set {
			if err := replaceAuthors(ctx, queries, viewer, id, now, *patch.Authors.Value); err != nil {
				return err
			}
		}
		if patch.Tags.Set {
			if err := replaceTags(ctx, queries, id, now, *patch.Tags.Value); err != nil {
				return err
			}
		}
		if patch.Identifiers.Set {
			if err := replaceIdentifiers(ctx, queries, id, *patch.Identifiers.Value); err != nil {
				return err
			}
		}
		if err := queries.CatalogUpdateBook(ctx, sqlc.CatalogUpdateBookParams{
			ID: id, LibraryID: row.LibraryID, Title: row.Title, SortTitle: row.SortTitle,
			Subtitle: row.Subtitle, Description: row.Description, Language: row.Language,
			Publisher: row.Publisher, PublishedDate: row.PublishedDate, PageCount: row.PageCount,
			SeriesID: row.SeriesID, SeriesIndex: row.SeriesIndex, UpdatedAt: now,
		}); err != nil {
			return fmt.Errorf("update book: %w", err)
		}
		for _, field := range fields {
			if _, selected := sources[field]; !selected {
				if err := setManualSource(ctx, queries, viewer, id, field, now); err != nil {
					return err
				}
			}
		}
		if cover != nil {
			if err := queries.CatalogUpdateCover(ctx, sqlc.CatalogUpdateCoverParams{
				ID: id, CoverSha256: sql.NullString{String: cover.FullSHA256, Valid: true},
				CoverSource: sql.NullString{String: sources["cover"].Provider, Valid: true}, UpdatedAt: now,
			}); err != nil {
				return fmt.Errorf("update provider cover: %w", err)
			}
		}
		for field, source := range sources {
			if err := queries.MetadataUpsertFieldSource(ctx, sqlc.MetadataUpsertFieldSourceParams{
				BookID: id, Field: field, Source: source.Provider,
				SourceRef: sql.NullString{String: source.Reference, Valid: true},
				ChosenBy:  sql.NullInt64{Int64: viewer.UserID, Valid: true}, ChosenAt: now,
			}); err != nil {
				return fmt.Errorf("update provider field source: %w", err)
			}
		}
		if err := search.IndexBook(ctx, tx, id); err != nil {
			return err
		}
		updated, err := visibleBook(ctx, queries, viewer, id)
		if err != nil {
			return err
		}
		result, err = hydrateBook(ctx, queries, viewer, updated)
		return err
	})
	return result, err
}

func setManualSource(ctx context.Context, queries *sqlc.Queries, viewer Viewer, bookID int64, field string, now int64) error {
	if err := queries.CatalogUpsertFieldSource(ctx, sqlc.CatalogUpsertFieldSourceParams{
		BookID: bookID, Field: field, ChosenBy: sql.NullInt64{Int64: viewer.UserID, Valid: true}, ChosenAt: now,
	}); err != nil {
		return fmt.Errorf("update %s field source: %w", field, err)
	}
	return nil
}

func replaceAuthors(ctx context.Context, queries *sqlc.Queries, viewer Viewer, bookID, now int64, authors []AuthorInput) error {
	old, err := queries.CatalogBookAuthors(ctx, sqlc.CatalogBookAuthorsParams{
		BookID: bookID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return fmt.Errorf("load existing authors: %w", err)
	}
	if err := queries.CatalogClearBookAuthors(ctx, bookID); err != nil {
		return fmt.Errorf("clear book authors: %w", err)
	}
	for position, author := range authors {
		if err := queries.CatalogInsertAuthor(ctx, sqlc.CatalogInsertAuthorParams{
			Name: author.Name, SortName: author.Name, CreatedAt: now,
		}); err != nil {
			return fmt.Errorf("create author: %w", err)
		}
		authorID, err := queries.CatalogAuthorByName(ctx, author.Name)
		if err != nil {
			return fmt.Errorf("find author: %w", err)
		}
		if err := queries.CatalogInsertBookAuthor(ctx, sqlc.CatalogInsertBookAuthorParams{
			BookID: bookID, AuthorID: authorID, Role: author.Role, Position: int64(position),
		}); err != nil {
			return fmt.Errorf("link book author: %w", err)
		}
	}
	for _, author := range old {
		if err := queries.CatalogDeleteOrphanAuthor(ctx, author.ID); err != nil {
			return fmt.Errorf("remove orphan author: %w", err)
		}
	}
	return nil
}

func replaceTags(ctx context.Context, queries *sqlc.Queries, bookID, now int64, tags []string) error {
	if err := queries.CatalogClearBookTags(ctx, bookID); err != nil {
		return fmt.Errorf("clear book tags: %w", err)
	}
	for _, tag := range tags {
		if err := queries.CatalogInsertTag(ctx, sqlc.CatalogInsertTagParams{Name: tag, CreatedAt: now}); err != nil {
			return fmt.Errorf("create tag: %w", err)
		}
		tagID, err := queries.CatalogTagByName(ctx, tag)
		if err != nil {
			return fmt.Errorf("find tag: %w", err)
		}
		if err := queries.CatalogInsertBookTag(ctx, sqlc.CatalogInsertBookTagParams{
			BookID: bookID, TagID: tagID,
		}); err != nil {
			return fmt.Errorf("link book tag: %w", err)
		}
	}
	return nil
}

func replaceIdentifiers(ctx context.Context, queries *sqlc.Queries, bookID int64, identifiers []Identifier) error {
	if err := queries.CatalogClearBookIdentifiers(ctx, bookID); err != nil {
		return fmt.Errorf("clear book identifiers: %w", err)
	}
	for _, identifier := range identifiers {
		if err := queries.CatalogInsertBookIdentifier(ctx, sqlc.CatalogInsertBookIdentifierParams{
			BookID: bookID, Scheme: identifier.Scheme, Value: identifier.Value,
		}); err != nil {
			return fmt.Errorf("add book identifier: %w", err)
		}
	}
	return nil
}

// DeleteBook removes a visible book, its dependent data, and its search documents.
func (s *Service) DeleteBook(ctx context.Context, viewer Viewer, id int64) error {
	if err := checkAdmin(viewer); err != nil {
		return err
	}
	if id < 1 {
		return invalid("book ID is invalid")
	}
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if _, err := visibleBook(ctx, queries, viewer, id); err != nil {
			return err
		}
		authors, err := queries.CatalogBookAuthors(ctx, sqlc.CatalogBookAuthorsParams{
			BookID: id, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
		})
		if err != nil {
			return fmt.Errorf("load deleted book authors: %w", err)
		}
		// sqlc's SQLite parser does not expose FTS rowid.
		for _, statement := range []string{
			`DELETE FROM notes_fts WHERE rowid IN (
				SELECT seq FROM notes WHERE book_id = ?1
				OR highlight_id IN (SELECT id FROM highlights WHERE book_id = ?1))`,
			`DELETE FROM highlights_fts WHERE rowid IN (SELECT seq FROM highlights WHERE book_id = ?)`,
			`DELETE FROM books_fts WHERE rowid = ?`,
		} {
			if _, err := tx.ExecContext(ctx, statement, id); err != nil {
				return fmt.Errorf("remove book search documents: %w", err)
			}
		}
		deleted, err := queries.CatalogDeleteBook(ctx, id)
		if err != nil {
			return fmt.Errorf("delete book: %w", err)
		}
		if deleted != 1 {
			return ErrNotFound
		}
		for _, author := range authors {
			if err := queries.CatalogDeleteOrphanAuthor(ctx, author.ID); err != nil {
				return fmt.Errorf("remove orphan author: %w", err)
			}
		}
		return nil
	})
}
