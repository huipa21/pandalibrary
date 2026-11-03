package pdf

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	pdfcpu "github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"

	"pandalibrary/internal/extract"
)

func Register(registry *extract.Registry) error {
	return registry.Register(extract.FormatPDF, Extract)
}

func Extract(ctx context.Context, input io.ReaderAt, size int64, _ string) (extract.Metadata, error) {
	if ctx == nil || input == nil || size <= 0 {
		return extract.Metadata{}, fmt.Errorf("%w: PDF input and context are required", extract.ErrInvalidInput)
	}
	if size > extract.MaxCompressedInput {
		return extract.Metadata{}, fmt.Errorf("%w: PDF is %d bytes", extract.ErrTooLarge, size)
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}

	config := model.NewDefaultConfiguration()
	config.Limits.MaxInputBytes = extract.MaxCompressedInput
	config.Limits.MaxObjectBytes = 16 << 20
	config.Limits.MaxStreamBytes = 64 << 20
	config.Limits.MaxDecodeBytes = 64 << 20
	config.Limits.MaxImagePixels = 20_000_000
	config.Limits.MaxImageBytes = 80 << 20
	config.Limits.MaxObjectCount = 1_000_000
	config.Limits.MaxObjectStreamCount = 100_000
	config.Limits.MaxObjectStreamFirst = 8 << 20
	config.Limits.MaxXRefEntries = 1_000_000
	config.Limits.MaxRecursionDepth = 100

	pdfContext, err := api.ReadContext(ctx, io.NewSectionReader(input, 0, size), config)
	if err != nil {
		return extract.Metadata{}, pdfError(ctx, err)
	}
	if pdfContext == nil || pdfContext.XRefTable == nil {
		return extract.Metadata{}, fmt.Errorf("%w: PDF parser returned no document", extract.ErrInvalidInput)
	}
	if pdfContext.Encrypt != nil {
		return extract.Metadata{}, fmt.Errorf("%w: encrypted PDFs are not supported", extract.ErrUnsupportedFormat)
	}
	if err := api.ValidateContext(ctx, pdfContext); err != nil {
		return extract.Metadata{}, pdfError(ctx, err)
	}
	if pdfContext.PageCount <= 0 {
		return extract.Metadata{}, fmt.Errorf("%w: PDF has no pages", extract.ErrInvalidInput)
	}
	if err := ctx.Err(); err != nil {
		return extract.Metadata{}, err
	}

	metadata := extract.Metadata{
		Title:       strings.TrimSpace(pdfContext.Title),
		Description: optionalString(pdfContext.Subject),
		PageCount:   &pdfContext.PageCount,
	}
	if author := strings.TrimSpace(pdfContext.Author); author != "" {
		metadata.Authors = []extract.Author{{Name: author, Role: "author"}}
	}
	metadata.Tags = parseKeywords(pdfContext.Keywords)
	return metadata, nil
}

func pdfError(ctx context.Context, err error) error {
	if contextErr := ctx.Err(); contextErr != nil {
		return contextErr
	}
	if errors.Is(err, pdfcpu.ErrWrongPassword) || errors.Is(err, pdfcpu.ErrOwnerPasswordRequired) {
		return fmt.Errorf("%w: encrypted PDFs are not supported: %v", extract.ErrUnsupportedFormat, err)
	}
	return fmt.Errorf("%w: parse PDF: %v", extract.ErrInvalidInput, err)
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func parseKeywords(value string) []string {
	seen := make(map[string]struct{})
	var result []string
	for _, keyword := range strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == ';'
	}) {
		keyword = strings.TrimSpace(keyword)
		if keyword == "" {
			continue
		}
		if _, exists := seen[keyword]; exists {
			continue
		}
		seen[keyword] = struct{}{}
		result = append(result, keyword)
	}
	sort.Strings(result)
	return result
}
