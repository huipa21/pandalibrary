package metadata

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/covers"
	"pandalibrary/internal/db/sqlc"
)

// Apply combines server-cached selections and manual edits with per-field provenance.
func (s *Service) Apply(ctx context.Context, viewer catalog.Viewer, bookID int64, request ApplyRequest) (catalog.Book, error) {
	if err := admin(viewer); err != nil {
		return catalog.Book{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err := s.catalog.CheckVisible(ctx, viewer, bookID); err != nil {
		return catalog.Book{}, err
	}
	if !validSelectionKey(bookID, request.RequestKey) || len(request.Fields) == 0 || len(request.Fields) > 12 {
		return catalog.Book{}, ErrInvalid
	}
	if err := waitForLock(ctx, s.config.TryRLock); err != nil {
		return catalog.Book{}, err
	}
	defer s.config.RUnlock()
	var patch catalog.BookPatch
	sources := map[string]catalog.MetadataSource{}
	var cover *covers.Result
	for field, selection := range request.Fields {
		candidate, row, err := s.selected(ctx, request.RequestKey, selection)
		if err != nil {
			return catalog.Book{}, err
		}
		sources[field] = catalog.MetadataSource{Provider: candidate.Provider, Reference: candidate.Reference}
		switch field {
		case "title":
			patch.Title = catalog.Optional[string]{Set: true, Value: &candidate.Title}
		case "subtitle":
			patch.Subtitle = catalog.Optional[string]{Set: true, Value: candidate.Subtitle}
		case "description":
			patch.Description = catalog.Optional[string]{Set: true, Value: candidate.Description}
		case "publisher":
			patch.Publisher = catalog.Optional[string]{Set: true, Value: candidate.Publisher}
		case "published_date":
			patch.PublishedDate = catalog.Optional[string]{Set: true, Value: candidate.PublishedDate}
		case "language":
			patch.Language = catalog.Optional[string]{Set: true, Value: candidate.Language}
		case "page_count":
			patch.PageCount = catalog.Optional[int64]{Set: true, Value: candidate.PageCount}
		case "series":
			patch.Series.Set = true
			if candidate.Series != nil {
				patch.Series.Value = &catalog.SeriesInput{Name: candidate.Series.Name, Index: candidate.Series.Index}
			}
		case "authors":
			authors := make([]catalog.AuthorInput, 0, len(candidate.Authors))
			for _, person := range candidate.Authors {
				authors = append(authors, catalog.AuthorInput{Name: person.Name, Role: person.Role})
			}
			patch.Authors = catalog.Optional[[]catalog.AuthorInput]{Set: true, Value: &authors}
		case "tags":
			patch.Tags = catalog.Optional[[]string]{Set: true, Value: &candidate.Tags}
		case "identifiers":
			ids := make([]catalog.Identifier, 0, len(candidate.Identifiers))
			for _, id := range candidate.Identifiers {
				ids = append(ids, catalog.Identifier{Scheme: id.Scheme, Value: id.Value})
			}
			patch.Identifiers = catalog.Optional[[]catalog.Identifier]{Set: true, Value: &ids}
		case "cover":
			normalized, err := s.downloadCover(ctx, candidate, row)
			if err != nil {
				return catalog.Book{}, err
			}
			cover = &normalized
		default:
			return catalog.Book{}, ErrInvalid
		}
	}
	return s.catalog.ApplyMetadataWithPatch(ctx, viewer, bookID, patch, sources, cover, request.Patch)
}

// Cover retrieves a cached candidate's cover for administrator preview.
func (s *Service) Cover(ctx context.Context, viewer catalog.Viewer, bookID int64, request CoverRequest) (covers.Result, error) {
	if err := admin(viewer); err != nil {
		return covers.Result{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err := s.catalog.CheckVisible(ctx, viewer, bookID); err != nil {
		return covers.Result{}, err
	}
	if !validSelectionKey(bookID, request.RequestKey) {
		return covers.Result{}, ErrInvalid
	}
	if err := waitForLock(ctx, s.config.TryRLock); err != nil {
		return covers.Result{}, err
	}
	defer s.config.RUnlock()
	candidate, row, err := s.selected(ctx, request.RequestKey, request.Selection)
	if err != nil {
		return covers.Result{}, err
	}
	return s.downloadCover(ctx, candidate, row)
}

func (s *Service) downloadCover(ctx context.Context, candidate Candidate, row sqlc.MetadataProvider) (covers.Result, error) {
	if candidate.CoverURL == nil {
		return covers.Result{}, ErrNotFound
	}
	base, err := parseBase(row.Provider, settings(row).BaseURL)
	if err != nil {
		return covers.Result{}, ErrInvalid
	}
	policy := networkPolicy{provider: row.Provider, base: base, explicit: row.BaseUrl.Valid, cover: true}
	target, err := url.Parse(*candidate.CoverURL)
	if err != nil || policy.validate(target) != nil {
		return covers.Result{}, ErrInvalid
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return covers.Result{}, ErrInvalid
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "image/jpeg, image/png, image/webp, image/gif")
	response, err := policy.client().Do(req)
	if err != nil {
		return covers.Result{}, failure("cover_download_failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return covers.Result{}, failure("cover_download_failed")
	}
	if response.ContentLength > covers.MaxInputBytes {
		return covers.Result{}, catalog.ErrTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, covers.MaxInputBytes+1))
	if err != nil {
		return covers.Result{}, failure("cover_download_failed")
	}
	normalized, err := covers.Normalize(data)
	if err != nil {
		return covers.Result{}, fmt.Errorf("normalize provider cover: %w", err)
	}
	return normalized, nil
}
