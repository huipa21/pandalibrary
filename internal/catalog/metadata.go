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
	if err := checkAdmin(viewer); err != nil {
		return Book{}, err
	}
	if sources == nil {
		return Book{}, invalid("provider provenance is required")
	}
	if err := s.CheckVisible(ctx, viewer, id); err != nil {
		return Book{}, err
	}
	return s.updateBook(ctx, viewer, id, patch, sources, cover)
}
