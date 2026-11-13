package importer

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/covers"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/extract"
	"pandalibrary/internal/search"
)

func (s *Service) process(ctx context.Context, row sqlc.ImportJob) {
	input, err := s.readManifest(row.ID)
	if err == nil {
		s.hookStarted(ctx, row, input)
	}
	if err == nil && input.Failure != "" {
		err = errors.New(input.Failure)
	}
	if err == nil {
		err = s.importBook(ctx, row, input)
	}
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		s.options.Logger.Error("import job failed", "job_id", row.ID, "error", err)
		if err := s.finish(ctx, sqlc.New(s.options.Writer), row.ID, "failed", 0, 0, s.safeError(err)); err != nil {
			s.options.Logger.Error("persist import failure", "job_id", row.ID, "error", err)
			return
		}
	}
	finished, err := sqlc.New(s.options.Reader).ImportJob(ctx, row.ID)
	if err == nil {
		s.hookFinished(finished, input)
		err = s.cleanup(finished, input)
	}
	if err != nil {
		s.options.Logger.Error("clean up import job", "job_id", row.ID, "error", err)
	}
}

func (s *Service) importBook(ctx context.Context, row sqlc.ImportJob, input manifest) error {
	var duplicate bool
	err := db.WithTx(ctx, s.options.Writer, func(tx *sql.Tx) error {
		var err error
		duplicate, err = s.finishDuplicate(ctx, sqlc.New(tx), row, input)
		return err
	})
	if err != nil || duplicate {
		return err
	}
	file, err := s.options.Blobs.OpenStaged(input.Staged.Token)
	if err != nil {
		return err
	}
	format, sniffErr := extract.Sniff(file, input.Staged.Size)
	var metadata extract.Metadata
	if sniffErr == nil {
		metadata, err = s.registry.Extract(ctx, file, input.Staged.Size, row.OriginalName)
	} else {
		err = sniffErr
	}
	if err := errors.Join(err, file.Close()); err != nil {
		return err
	}
	coverHash := ""
	if len(metadata.Cover) > 0 {
		normalized, err := covers.Normalize(metadata.Cover)
		if err != nil {
			return err
		}
		if err := s.options.Blobs.PublishCover(normalized.FullSHA256, normalized.FullJPEG, normalized.ThumbnailJPEG); err != nil {
			return err
		}
		coverHash = normalized.FullSHA256
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.options.Blobs.PublishBook(ctx, input.Staged, string(format)); err != nil {
		return err
	}
	return db.WithTx(ctx, s.options.Writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		duplicate, err := s.finishDuplicate(ctx, queries, row, input)
		if err != nil || duplicate {
			return err
		}
		bookID := input.BookID
		if bookID == 0 {
			bookID, err = createBook(ctx, queries, row, metadata, coverHash)
			if err != nil {
				return err
			}
			if row.Source == "upload" {
				visibility := input.Visibility
				if visibility == "" {
					visibility = "library"
				}
				if visibility != "public" && visibility != "private" && visibility != "library" {
					return catalog.ErrInvalid
				}
				if _, err := tx.ExecContext(ctx, `UPDATE books SET owner_id = ?, visibility = ? WHERE id = ?`,
					row.UserID, visibility, bookID); err != nil {
					return err
				}
			}
		}
		if err := queries.ImportFile(ctx, sqlc.ImportFileParams{BookID: bookID, Sha256: input.Staged.SHA256,
			Format: string(format), SizeBytes: input.Staged.Size, OriginalFilename: row.OriginalName,
			KoreaderMd5: text(input.Staged.KOReaderMD5), CreatedAt: time.Now().UnixMilli()}); err != nil {
			return err
		}
		if err := search.IndexBook(ctx, tx, bookID); err != nil {
			return err
		}
		if hook := s.hook(row.Source); hook != nil {
			if err := hook.Imported(ctx, tx, jobDTO(row), bookID, input.Hook); err != nil {
				return err
			}
		}
		return s.finish(ctx, queries, row.ID, "imported", bookID, 0, "")
	})
}

// Duplicate resolution and its persisted result share a transaction with moves.
func (s *Service) finishDuplicate(ctx context.Context, queries *sqlc.Queries, row sqlc.ImportJob, input manifest) (bool, error) {
	if input.BookID != 0 {
		if _, err := queries.ImportTarget(ctx, sqlc.ImportTargetParams{BookID: input.BookID, LibraryID: row.LibraryID, UserID: row.UserID.Int64}); err != nil {
			return false, fmt.Errorf("attachment target changed: %w", err)
		}
	}
	duplicate, err := queries.ImportDuplicate(ctx, sqlc.ImportDuplicateParams{
		Sha256: input.Staged.SHA256, LibraryID: row.LibraryID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, s.finish(ctx, queries, row.ID, "duplicate", 0, duplicate, "")
}

func createBook(ctx context.Context, queries *sqlc.Queries, row sqlc.ImportJob, metadata extract.Metadata, coverHash string) (int64, error) {
	now := time.Now().UnixMilli()
	metadata.Title = strings.TrimSpace(metadata.Title)
	if metadata.Title == "" {
		metadata.Title = strings.TrimSuffix(row.OriginalName, filepath.Ext(row.OriginalName))
		metadata.Title = strings.Join(strings.Fields(strings.NewReplacer("_", " ", ".", " ").Replace(metadata.Title)), " ")
		if metadata.Title == "" {
			metadata.Title = "Untitled"
		}
	}
	params := sqlc.ImportCreateBookParams{LibraryID: row.LibraryID, Title: metadata.Title, SortTitle: catalog.SortTitle(metadata.Title),
		Subtitle: optionalText(metadata.Subtitle), Description: optionalText(metadata.Description), Language: optionalText(metadata.Language),
		Publisher: optionalText(metadata.Publisher), PublishedDate: optionalText(metadata.Date), CoverSha256: text(coverHash),
		AddedBy: row.UserID, CreatedAt: now, UpdatedAt: now}
	fields := []string{"title"}
	for _, field := range []struct {
		name  string
		value sql.NullString
	}{
		{"subtitle", params.Subtitle}, {"description", params.Description}, {"language", params.Language},
		{"publisher", params.Publisher}, {"published_date", params.PublishedDate},
	} {
		if field.value.Valid {
			fields = append(fields, field.name)
		}
	}
	if metadata.PageCount != nil {
		params.PageCount = nullableID(int64(*metadata.PageCount))
		fields = append(fields, "page_count")
	}
	if metadata.Series != nil && strings.TrimSpace(*metadata.Series) != "" {
		seriesID, err := queries.ImportSeries(ctx, sqlc.ImportSeriesParams{Name: strings.TrimSpace(*metadata.Series), CreatedAt: now})
		if err != nil {
			return 0, err
		}
		params.SeriesID = nullableID(seriesID)
		if metadata.SeriesIndex != nil {
			params.SeriesIndex = sql.NullFloat64{Float64: *metadata.SeriesIndex, Valid: true}
		}
		fields = append(fields, "series")
	}
	if coverHash != "" {
		params.CoverSource = text("file")
		fields = append(fields, "cover")
	}
	bookID, err := queries.ImportCreateBook(ctx, params)
	if err != nil {
		return 0, err
	}
	for position, author := range metadata.Authors {
		name := strings.TrimSpace(author.Name)
		if name == "" {
			continue
		}
		role := author.Role
		if role == "" {
			role = "author"
		}
		sortName := author.FileAs
		if sortName == "" {
			sortName = name
		}
		authorID, err := queries.ImportAuthor(ctx, sqlc.ImportAuthorParams{Name: name, SortName: sortName, CreatedAt: now})
		if err != nil {
			return 0, err
		}
		if err := queries.ImportLinkAuthor(ctx, sqlc.ImportLinkAuthorParams{BookID: bookID, AuthorID: authorID, Role: role, Position: int64(position)}); err != nil {
			return 0, err
		}
	}
	if len(metadata.Authors) > 0 {
		fields = append(fields, "authors")
	}
	for _, tag := range metadata.Tags {
		if strings.TrimSpace(tag) == "" {
			continue
		}
		tagID, err := queries.ImportTag(ctx, sqlc.ImportTagParams{Name: strings.TrimSpace(tag), CreatedAt: now})
		if err != nil {
			return 0, err
		}
		if err := queries.ImportLinkTag(ctx, sqlc.ImportLinkTagParams{BookID: bookID, TagID: tagID}); err != nil {
			return 0, err
		}
	}
	if len(metadata.Tags) > 0 {
		fields = append(fields, "tags")
	}
	for _, identifier := range metadata.Identifiers {
		if err := queries.ImportIdentifier(ctx, sqlc.ImportIdentifierParams{BookID: bookID, Scheme: identifier.Scheme, Value: identifier.Value}); err != nil {
			return 0, err
		}
	}
	if len(metadata.Identifiers) > 0 {
		fields = append(fields, "identifiers")
	}
	for _, field := range fields {
		if err := queries.ImportFieldSource(ctx, sqlc.ImportFieldSourceParams{BookID: bookID, Field: field, ChosenBy: row.UserID, ChosenAt: now}); err != nil {
			return 0, err
		}
	}
	return bookID, nil
}

func (s *Service) cleanup(row sqlc.ImportJob, input manifest) (returnErr error) {
	if input.DropPath != "" {
		if err := s.cleanupDrop(row, input); err != nil {
			if !errors.Is(err, errDropChanged) {
				return err
			}
			s.options.Logger.Warn("preserving replaced drop source", "job_id", row.ID)
		}
		s.dropMu.Lock()
		delete(s.dropQueued, input.DropPath)
		s.dropMu.Unlock()
		select {
		case s.rescan <- struct{}{}:
		default:
		}
	}
	if input.Staged.Token != "" {
		if err := s.options.Blobs.RemoveStaged(input.Staged.Token); err != nil {
			return err
		}
	}
	root, err := os.OpenRoot(s.options.DataDir)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, root.Close()) }()
	if err := root.Remove(manifestName(row.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
