package extract

import (
	"context"
	"errors"
	"fmt"
	"io"
)

type Format string

const (
	FormatEPUB Format = "epub"
	FormatPDF  Format = "pdf"
	FormatMOBI Format = "mobi"
	FormatAZW3 Format = "azw3"
	FormatFB2  Format = "fb2"
	FormatFBZ  Format = "fbz"
	FormatCBZ  Format = "cbz"
)

var (
	ErrInvalidInput      = errors.New("invalid input")
	ErrUnsupportedFormat = errors.New("unsupported format")
	ErrNotRegistered     = errors.New("extractor is not registered")
	ErrTooLarge          = errors.New("input exceeds safety limits")
	ErrTimeout           = errors.New("extraction timed out")
	ErrExtractorPanic    = errors.New("extractor panicked")
)

type Author struct {
	Name   string
	Role   string
	FileAs string
}

type Identifier struct {
	Scheme string
	Value  string
}

type Metadata struct {
	Title       string
	Subtitle    *string
	Authors     []Author
	Language    *string
	Publisher   *string
	Date        *string
	Description *string
	Identifiers []Identifier
	Tags        []string
	Series      *string
	SeriesIndex *float64
	PageCount   *int
	Cover       []byte
}

type Extractor func(context.Context, io.ReaderAt, int64, string) (Metadata, error)

type FormatError struct {
	Format Format
	Err    error
}

func (e *FormatError) Error() string {
	if e.Format == "" {
		return e.Err.Error()
	}
	return fmt.Sprintf("%s: %v", e.Format, e.Err)
}

func (e *FormatError) Unwrap() error { return e.Err }
