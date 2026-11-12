package catalog

import (
	"context"
	"strings"

	"pandalibrary/internal/covers"
)

// MetadataSource identifies a trusted provider record selected by the metadata service.
type MetadataSource struct {
	Provider  string
	Reference string
}

func validMetadataSource(source MetadataSource) bool {
	switch source.Provider {
	case "openlibrary", "googlebooks", "neodb", "hardcover":
		return source.Reference != "" && len(source.Reference) <= 2048 && !strings.ContainsRune(source.Reference, 0)
	default:
		return false
	}
}

// ApplyMetadata commits selected fields, optional normalized cover, provenance, and
// the search index together. Callers must verify values against cached candidates.
func (s *Service) ApplyMetadata(ctx context.Context, viewer Viewer, id int64, patch BookPatch, sources map[string]MetadataSource, cover *covers.Result) (Book, error) {
	return s.ApplyMetadataWithPatch(ctx, viewer, id, patch, sources, cover, BookPatch{})
}

// ApplyMetadataWithPatch atomically applies trusted provider fields and disjoint
// manual edits. Every provider field still requires trusted provenance.
func (s *Service) ApplyMetadataWithPatch(ctx context.Context, viewer Viewer, id int64, patch BookPatch, sources map[string]MetadataSource, cover *covers.Result, manual BookPatch) (Book, error) {
	if err := checkAdmin(viewer); err != nil {
		return Book{}, err
	}
	if sources == nil {
		return Book{}, invalid("provider provenance is required")
	}
	if err := s.CheckVisible(ctx, viewer, id); err != nil {
		return Book{}, err
	}
	return s.updateBookWithManualPatch(ctx, viewer, id, patch, sources, cover, manual)
}

func mergeManualField[T any](selected, manual Optional[T]) Optional[T] {
	if manual.Set {
		return manual
	}
	return selected
}

func mergeManualPatch(patch, manual BookPatch) BookPatch {
	patch.Title = mergeManualField(patch.Title, manual.Title)
	patch.Subtitle = mergeManualField(patch.Subtitle, manual.Subtitle)
	patch.Description = mergeManualField(patch.Description, manual.Description)
	patch.Language = mergeManualField(patch.Language, manual.Language)
	patch.Publisher = mergeManualField(patch.Publisher, manual.Publisher)
	patch.PublishedDate = mergeManualField(patch.PublishedDate, manual.PublishedDate)
	patch.PageCount = mergeManualField(patch.PageCount, manual.PageCount)
	patch.Series = mergeManualField(patch.Series, manual.Series)
	patch.Authors = mergeManualField(patch.Authors, manual.Authors)
	patch.Tags = mergeManualField(patch.Tags, manual.Tags)
	patch.Identifiers = mergeManualField(patch.Identifiers, manual.Identifiers)
	return patch
}
