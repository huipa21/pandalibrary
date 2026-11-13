package export

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"pandalibrary/internal/db/sqlc"
)

var (
	ErrInvalid  = errors.New("invalid export request")
	ErrNotFound = errors.New("exported book not found")
	ErrTooLarge = errors.New("export is too large")
)

const (
	maxExportBooks     = 100
	maxAnnotationBytes = 16 << 20
	maxGeneratedBytes  = 32 << 20
	maxAnnotationRows  = 10000
)

// Viewer is the trusted identity supplied by the authenticated HTTP layer.
type Viewer struct {
	UserID  int64
	IsAdmin bool
}

// Result contains a fully generated bounded response.
type Result struct {
	ContentType string
	Filename    string
	Body        []byte
}

type Service struct {
	reader *sql.DB
	now    func() time.Time
}

// NewService constructs an export service over the shared database pools.
func NewService(writer, reader *sql.DB) (*Service, error) {
	if writer == nil || reader == nil {
		return nil, errors.New("export requires writer and reader databases")
	}
	return &Service{reader: reader, now: time.Now}, nil
}

type book struct {
	id          int64
	title       string
	authors     []string
	series      string
	seriesIndex sql.NullFloat64
	isbn        string
	tags        []string
}

type highlight struct {
	id       string
	position float64
	text     string
	style    string
}

type pageAnnotation struct {
	page int
	kind string
	text string
}

type note struct {
	highlightID string
	body        string
}

// Export exports all live annotations for the requested visible books.
func (s *Service) Export(ctx context.Context, viewer Viewer, bookIDs []int64) (result Result, returnErr error) {
	if viewer.UserID < 1 || len(bookIDs) < 1 || len(bookIDs) > maxExportBooks {
		return Result{}, fmt.Errorf("%w: select between 1 and 100 books", ErrInvalid)
	}
	seen := make(map[int64]struct{}, len(bookIDs))
	for _, id := range bookIDs {
		if id < 1 {
			return Result{}, fmt.Errorf("%w: book IDs must be positive", ErrInvalid)
		}
		if _, exists := seen[id]; exists {
			return Result{}, fmt.Errorf("%w: book IDs must be distinct", ErrInvalid)
		}
		seen[id] = struct{}{}
	}

	tx, err := s.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Result{}, fmt.Errorf("begin notes export snapshot: %w", err)
	}
	defer func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			returnErr = errors.Join(returnErr, fmt.Errorf("roll back notes export snapshot: %w", err))
		}
	}()
	queries := sqlc.New(tx)
	bookIDsJSON, err := json.Marshal(bookIDs)
	if err != nil {
		return Result{}, fmt.Errorf("encode export selection: %w", err)
	}
	isAdmin := int64(0)
	if viewer.IsAdmin {
		isAdmin = 1
	}
	bookRows, err := queries.ExportBooks(ctx, sqlc.ExportBooksParams{
		Isadmin: isAdmin, Userid: viewer.UserID, Bookidsjson: string(bookIDsJSON),
	})
	if err != nil {
		return Result{}, fmt.Errorf("query export books: %w", err)
	}
	if len(bookRows) != len(bookIDs) {
		return Result{}, ErrNotFound
	}
	books := make([]book, 0, len(bookRows))
	for _, row := range bookRows {
		authors, err := decodeStringList(row.Authors)
		if err != nil {
			return Result{}, fmt.Errorf("decode export authors: %w", err)
		}
		tags, err := decodeStringList(row.Tags)
		if err != nil {
			return Result{}, fmt.Errorf("decode export tags: %w", err)
		}
		books = append(books, book{
			id: row.ID, title: row.Title, authors: authors,
			series: row.SeriesName.String, seriesIndex: row.SeriesIndex,
			isbn: row.Isbn, tags: tags,
		})
	}
	contentBytes, err := queries.ExportContentBytes(ctx, sqlc.ExportContentBytesParams{
		Userid: viewer.UserID, Isadmin: isAdmin, Bookidsjson: string(bookIDsJSON),
	})
	if err != nil {
		return Result{}, fmt.Errorf("measure export annotations: %w", err)
	}
	if contentBytes > maxAnnotationBytes {
		return Result{}, ErrTooLarge
	}
	highlightRows, err := queries.ExportHighlights(ctx, sqlc.ExportHighlightsParams{
		Userid: viewer.UserID, Isadmin: isAdmin, Bookidsjson: string(bookIDsJSON),
	})
	if err != nil {
		return Result{}, fmt.Errorf("query export highlights: %w", err)
	}
	if len(highlightRows) > maxAnnotationRows {
		return Result{}, ErrTooLarge
	}
	noteRows, err := queries.ExportNotes(ctx, sqlc.ExportNotesParams{
		Userid: viewer.UserID, Isadmin: isAdmin, Bookidsjson: string(bookIDsJSON),
	})
	if err != nil {
		return Result{}, fmt.Errorf("query export notes: %w", err)
	}
	if len(noteRows) > maxAnnotationRows {
		return Result{}, ErrTooLarge
	}
	pageRows, err := queries.ExportPageAnnotations(ctx, sqlc.ExportPageAnnotationsParams{
		Userid: viewer.UserID, Isadmin: isAdmin, Bookidsjson: string(bookIDsJSON),
	})
	if err != nil {
		return Result{}, fmt.Errorf("query export page annotations: %w", err)
	}
	if len(highlightRows)+len(noteRows)+len(pageRows) > maxAnnotationRows {
		return Result{}, ErrTooLarge
	}
	if err := tx.Commit(); err != nil {
		return Result{}, fmt.Errorf("finish notes export snapshot: %w", err)
	}

	byBookHighlights := make(map[int64][]highlight, len(books))
	for _, row := range highlightRows {
		byBookHighlights[row.BookID] = append(byBookHighlights[row.BookID], highlight{
			id: row.ID, position: row.Position, text: row.Text, style: row.Style,
		})
	}
	byBookPages := make(map[int64][]pageAnnotation, len(books))
	for _, row := range pageRows {
		var locator struct {
			Page int `json:"page"`
		}
		var data struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal([]byte(row.Locator), &locator); err != nil || locator.Page < 1 {
			return Result{}, fmt.Errorf("invalid export page locator for %s", row.ID)
		}
		if err := json.Unmarshal([]byte(row.Data), &data); err != nil {
			return Result{}, fmt.Errorf("decode export page annotation %s: %w", row.ID, err)
		}
		if row.Kind != "text" && row.Kind != "ink" && row.Kind != "image" {
			return Result{}, fmt.Errorf("invalid export page annotation kind for %s", row.ID)
		}
		byBookPages[row.BookID] = append(byBookPages[row.BookID], pageAnnotation{
			page: locator.Page, kind: row.Kind, text: data.Text,
		})
	}
	byBookNotes := make(map[int64][]note, len(books))
	for _, row := range noteRows {
		byBookNotes[row.BookID] = append(byBookNotes[row.BookID], note{
			highlightID: row.HighlightID.String, body: row.BodyMd,
		})
	}
	date := s.now().UTC().Format("2006-01-02")
	if len(books) == 1 {
		filename := markdownFilename(books[0].title, books[0].authors)
		var output bytes.Buffer
		writer := &limitedWriter{writer: &output, limit: maxGeneratedBytes}
		if err := writeDocument(writer, books[0], byBookNotes[books[0].id],
			byBookHighlights[books[0].id], byBookPages[books[0].id], date); err != nil {
			return Result{}, err
		}
		return Result{ContentType: "text/markdown; charset=utf-8", Filename: filename, Body: output.Bytes()}, nil
	}

	names := uniqueMarkdownFilenames(books)
	var output bytes.Buffer
	zipWriter := zip.NewWriter(&limitedWriter{writer: &output, limit: maxGeneratedBytes})
	uncompressed := &countingWriter{limit: maxGeneratedBytes}
	for index, item := range books {
		entry, err := zipWriter.Create(names[index])
		if err != nil {
			return Result{}, fmt.Errorf("create notes archive entry: %w", err)
		}
		uncompressed.writer = entry
		if err := writeDocument(uncompressed, item, byBookNotes[item.id],
			byBookHighlights[item.id], byBookPages[item.id], date); err != nil {
			_ = zipWriter.Close()
			return Result{}, err
		}
	}
	if err := zipWriter.Close(); err != nil {
		return Result{}, fmt.Errorf("finish notes archive: %w", err)
	}
	return Result{
		ContentType: "application/zip",
		Filename:    "PandaLibrary notes " + date + ".zip",
		Body:        output.Bytes(),
	}, nil
}

func decodeStringList(value string) ([]string, error) {
	var result []string
	if err := json.Unmarshal([]byte(value), &result); err != nil {
		return nil, err
	}
	if result == nil {
		return []string{}, nil
	}
	return result, nil
}

type limitedWriter struct {
	writer io.Writer
	limit  int
	count  int
}

func (w *limitedWriter) Write(data []byte) (int, error) {
	if len(data) > w.limit-w.count {
		return 0, ErrTooLarge
	}
	written, err := w.writer.Write(data)
	w.count += written
	return written, err
}

type countingWriter struct {
	writer io.Writer
	limit  int
	count  int
}

func (w *countingWriter) Write(data []byte) (int, error) {
	if len(data) > w.limit-w.count {
		return 0, ErrTooLarge
	}
	written, err := w.writer.Write(data)
	w.count += written
	return written, err
}

func writeDocument(writer io.Writer, item book, notes []note, highlights []highlight, pages []pageAnnotation, date string) error {
	if _, err := io.WriteString(writer, "---\ntitle: "+yamlString(item.title)+"\nauthor:"); err != nil {
		return err
	}
	if len(item.authors) == 0 {
		if _, err := io.WriteString(writer, " []\n"); err != nil {
			return err
		}
	} else {
		if _, err := io.WriteString(writer, "\n"); err != nil {
			return err
		}
		for _, author := range item.authors {
			if _, err := io.WriteString(writer, "  - "+yamlString(author)+"\n"); err != nil {
				return err
			}
		}
	}
	if item.series != "" {
		if _, err := io.WriteString(writer, "series: "+yamlString(item.series)+"\n"); err != nil {
			return err
		}
		if item.seriesIndex.Valid {
			if _, err := io.WriteString(writer, "series_index: "+
				strconv.FormatFloat(item.seriesIndex.Float64, 'f', -1, 64)+"\n"); err != nil {
				return err
			}
		}
	}
	if item.isbn != "" {
		if _, err := io.WriteString(writer, "isbn: "+yamlString(item.isbn)+"\n"); err != nil {
			return err
		}
	}
	if len(item.tags) == 0 {
		if _, err := io.WriteString(writer, "tags: []\n"); err != nil {
			return err
		}
	} else {
		if _, err := io.WriteString(writer, "tags:\n"); err != nil {
			return err
		}
		for _, tag := range item.tags {
			if _, err := io.WriteString(writer, "  - "+yamlString(tag)+"\n"); err != nil {
				return err
			}
		}
	}
	if _, err := fmt.Fprintf(writer, "pandalibrary_id: %d\nexported: %s\n---\n# %s\n\n## Highlights\n\n",
		item.id, date, oneLine(item.title)); err != nil {
		return err
	}
	notesByHighlight := make(map[string][]note)
	for _, entry := range notes {
		notesByHighlight[entry.highlightID] = append(notesByHighlight[entry.highlightID], entry)
	}
	for _, entry := range highlights {
		// Explicit labels preserve arbitrary multiline text without introducing HTML or delimiters.
		if entry.style == "underline" || entry.style == "strikeout" {
			label := "Underline"
			if entry.style == "strikeout" {
				label = "Strikeout"
			}
			if _, err := fmt.Fprintf(writer, "**%s**\n\n", label); err != nil {
				return err
			}
		}
		if err := writeBlockquote(writer, entry.text, entry.id); err != nil {
			return err
		}
		for _, attached := range notesByHighlight[entry.id] {
			if err := writeMarkdownBody(writer, attached.body); err != nil {
				return err
			}
		}
	}
	if len(pages) == 0 {
		return nil
	}
	if _, err := io.WriteString(writer, "## Page annotations\n\n"); err != nil {
		return err
	}
	for _, page := range pages {
		label := "Note"
		switch page.kind {
		case "ink":
			label = "Drawing"
		case "image":
			label = "Image"
		}
		if _, err := fmt.Fprintf(writer, "%s on page %d", label, page.page); err != nil {
			return err
		}
		if page.kind == "text" {
			if _, err := io.WriteString(writer, ":\n\n"); err != nil {
				return err
			}
			if err := writeBlockquote(writer, page.text, ""); err != nil {
				return err
			}
		} else if _, err := io.WriteString(writer, "\n\n"); err != nil {
			return err
		}
	}
	return nil
}

func yamlString(value string) string {
	return strconv.Quote(strings.ToValidUTF8(value, "\uFFFD"))
}

func oneLine(value string) string {
	value = strings.NewReplacer("\r\n", " ", "\r", " ", "\n", " ").Replace(value)
	return strings.ToValidUTF8(value, "\uFFFD")
}

func writeMarkdownBody(writer io.Writer, body string) error {
	body = strings.ToValidUTF8(body, "\uFFFD")
	if body == "" {
		return nil
	}
	if _, err := io.WriteString(writer, body); err != nil {
		return err
	}
	if !strings.HasSuffix(body, "\n") {
		if _, err := io.WriteString(writer, "\n"); err != nil {
			return err
		}
	}
	_, err := io.WriteString(writer, "\n")
	return err
}

func writeBlockquote(writer io.Writer, text, id string) error {
	text = strings.ToValidUTF8(text, "\uFFFD")
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	lines := strings.Split(text, "\n")
	for index, line := range lines {
		if index == len(lines)-1 && id != "" {
			line += " ^hl-" + id
		}
		if _, err := io.WriteString(writer, "> "+line+"\n"); err != nil {
			return err
		}
	}
	_, err := io.WriteString(writer, "\n")
	return err
}
