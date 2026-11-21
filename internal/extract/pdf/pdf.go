package pdf

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"sort"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	pdfcpu "github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	_ "golang.org/x/image/webp"

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

	config := newConfiguration()

	pdfContext, err := api.ReadContext(ctx, io.NewSectionReader(input, 0, size), config)
	if err != nil {
		return extract.Metadata{}, pdfError(ctx, err)
	}
	if pdfContext == nil || pdfContext.XRefTable == nil {
		return extract.Metadata{}, fmt.Errorf("%w: PDF parser returned no document", extract.ErrInvalidInput)
	}
	// An /Encrypt entry does not necessarily mean a password is required. PDFs
	// can be owner-password-only (empty user password) and still open normally.
	// pdfcpu reports ErrWrongPassword or ErrOwnerPasswordRequired when user
	// credentials are actually needed, so reject only those errors below.
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
	cover, err := firstPageCover(ctx, input, size)
	if err != nil {
		return extract.Metadata{}, err
	}
	metadata.Cover = cover
	return metadata, nil
}

// firstPageCover returns the largest supported image on page 1. PDFs produced
// from scans or image conversions usually store the cover as one full-page
// image, while text-based PDFs have no usable cover image. Cover extraction is
// best effort: a malformed or unsupported image must not discard valid
// document metadata.
func firstPageCover(ctx context.Context, input io.ReaderAt, size int64) ([]byte, error) {
	images, _ := api.ExtractImagesRaw(ctx, io.NewSectionReader(input, 0, size), []string{"1"}, newConfiguration())
	if contextErr := ctx.Err(); contextErr != nil {
		return nil, contextErr
	}

	var cover []byte
	var coverPixels int64
	for _, page := range images {
		for _, imageInfo := range page {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if imageInfo.Reader == nil {
				continue
			}
			data, readErr := io.ReadAll(io.LimitReader(imageInfo.Reader, extract.MaxCoverEntrySize+1))
			if readErr != nil || len(data) == 0 || len(data) > extract.MaxCoverEntrySize {
				continue
			}
			config, format, decodeErr := image.DecodeConfig(bytes.NewReader(data))
			if decodeErr != nil || config.Width <= 0 || config.Height <= 0 || !coverImageFormat(format) {
				continue
			}
			pixels := int64(config.Width) * int64(config.Height)
			if pixels > 20_000_000 || pixels <= coverPixels {
				continue
			}
			cover = data
			coverPixels = pixels
		}
	}

	return cover, nil
}

func coverImageFormat(format string) bool {
	switch format {
	case "jpeg", "png", "gif", "webp":
		return true
	default:
		return false
	}
}

// newConfiguration builds a stateless pdfcpu configuration. PDF metadata
// extraction must not depend on a writable user config, font or certificate
// directory (for example in the container's scratch filesystem).
func newConfiguration() *model.Configuration {
	config := model.NewStatelessConfiguration()
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
	return config
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
