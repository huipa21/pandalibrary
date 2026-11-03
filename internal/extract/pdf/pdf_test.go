package pdf

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"

	"pandalibrary/internal/extract"
)

func TestExtractPDFInfoAndPageCount(t *testing.T) {
	data := makePDF(t, `/Title (Fixture Title) /Author (Ada Example) /Subject (A short description) /Keywords (art, history; fiction)`)
	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "ignored.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "Fixture Title" || metadata.Description == nil || *metadata.Description != "A short description" {
		t.Fatalf("unexpected descriptive metadata: %#v", metadata)
	}
	if len(metadata.Authors) != 1 || metadata.Authors[0] != (extract.Author{Name: "Ada Example", Role: "author"}) {
		t.Fatalf("unexpected authors: %#v", metadata.Authors)
	}
	if len(metadata.Tags) != 3 || metadata.Tags[0] != "art" || metadata.Tags[1] != "fiction" || metadata.Tags[2] != "history" {
		t.Fatalf("unexpected keywords: %#v", metadata.Tags)
	}
	if metadata.PageCount == nil || *metadata.PageCount != 1 {
		t.Fatalf("page count = %#v, want 1", metadata.PageCount)
	}
	if len(metadata.Cover) != 0 {
		t.Fatal("PDF extractor must not render a cover")
	}
}

func TestExtractPDFAcceptsAbsentOptionalFields(t *testing.T) {
	data := makePDF(t, "")
	metadata, err := Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "empty.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "" || metadata.Description != nil || len(metadata.Authors) != 0 || len(metadata.Tags) != 0 {
		t.Fatalf("unexpected optional metadata: %#v", metadata)
	}
	if metadata.PageCount == nil || *metadata.PageCount != 1 {
		t.Fatalf("page count = %#v, want 1", metadata.PageCount)
	}
}

func TestExtractPDFRejectsMalformedAndEncryptedInputsWithoutMetadata(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want error
	}{
		{name: "malformed", data: []byte("%PDF-1.7\nnot a document"), want: extract.ErrInvalidInput},
		{name: "encrypted", data: encryptedPDF(t), want: extract.ErrUnsupportedFormat},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			metadata, err := Extract(context.Background(), bytes.NewReader(test.data), int64(len(test.data)), "book.pdf")
			if !errors.Is(err, test.want) {
				t.Fatalf("Extract() error = %v, want %v", err, test.want)
			}
			if !reflect.DeepEqual(metadata, extract.Metadata{}) {
				t.Fatalf("Extract() returned partial metadata %#v", metadata)
			}
		})
	}
}

func TestExtractPDFRejectsOversizedInput(t *testing.T) {
	_, err := Extract(context.Background(), emptyReaderAt{}, extract.MaxCompressedInput+1, "large.pdf")
	if !errors.Is(err, extract.ErrTooLarge) {
		t.Fatalf("Extract() error = %v, want too large", err)
	}
}

func TestRegisteredPDFExtraction(t *testing.T) {
	data := makePDF(t, `/Title (Registered PDF)`)
	registry := extract.NewRegistry(0)
	if err := Register(registry); err != nil {
		t.Fatal(err)
	}
	metadata, err := registry.Extract(context.Background(), bytes.NewReader(data), int64(len(data)), "book.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Title != "Registered PDF" {
		t.Fatalf("title = %q", metadata.Title)
	}
	if err := Register(registry); !errors.Is(err, extract.ErrInvalidInput) {
		t.Fatalf("duplicate Register() error = %v, want invalid input", err)
	}
}

func makePDF(t *testing.T, info string) []byte {
	t.Helper()
	objects := []string{
		`<< /Type /Catalog /Pages 2 0 R >>`,
		`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>`,
		"<< /Length 0 >>\nstream\n\nendstream",
	}
	if strings.TrimSpace(info) != "" {
		objects = append(objects, "<< "+info+" >>")
	}
	var output bytes.Buffer
	output.WriteString("%PDF-1.7\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = output.Len()
		fmt.Fprintf(&output, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xrefOffset := output.Len()
	fmt.Fprintf(&output, "xref\n0 %d\n", len(offsets))
	output.WriteString("0000000000 65535 f \n")
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&output, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&output, "trailer\n<< /Size %d /Root 1 0 R", len(offsets))
	if len(objects) == 5 {
		output.WriteString(" /Info 5 0 R")
	}
	fmt.Fprintf(&output, " >>\nstartxref\n%d\n%%%%EOF\n", xrefOffset)
	return output.Bytes()
}

func encryptedPDF(t *testing.T) []byte {
	t.Helper()
	config := model.NewDefaultConfiguration()
	config.UserPW = "reader password"
	config.OwnerPW = "owner password"
	var encrypted bytes.Buffer
	if err := api.Encrypt(context.Background(), bytes.NewReader(makePDF(t, `/Title (Encrypted)`)), &encrypted, config); err != nil {
		t.Fatalf("encrypt test PDF: %v", err)
	}
	return encrypted.Bytes()
}

type emptyReaderAt struct{}

func (emptyReaderAt) ReadAt([]byte, int64) (int, error) {
	return 0, errors.New("unexpected read")
}
