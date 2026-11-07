package opds

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
)

const pageSize = 50

var errInvalidCursor = errors.New("cursor does not match this list")

// The visibility clauses are the catalog predicate (catalog.sql CatalogGetBook);
// every returned ID is hydrated again through catalog.GetBook.
const statusBooksQuery = `
SELECT ub.book_id, ub.updated_at FROM user_books ub
JOIN books b ON b.id = ub.book_id
WHERE ub.user_id = ?1
AND (ub.status = ?2 OR (?2 = 'reading' AND ub.status IN ('on_hold', 'rereading')))
AND (CAST(?3 AS INTEGER) = 1 OR EXISTS (
    SELECT 1 FROM library_access la
    WHERE la.library_id = b.library_id AND la.user_id = ?1
))
AND NOT EXISTS (
    SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = ?1
)
AND (CAST(?4 AS INTEGER) = 0
    OR ub.updated_at < CAST(?5 AS INTEGER)
    OR (ub.updated_at = CAST(?5 AS INTEGER) AND ub.book_id < ?4))
ORDER BY ub.updated_at DESC, ub.book_id DESC
LIMIT ?6`

type statusCursor struct {
	Version int    `json:"v"`
	Status  string `json:"s"`
	UserID  int64  `json:"u"`
	Admin   bool   `json:"a"`
	Updated int64  `json:"t"`
	ID      int64  `json:"i"`
}

func decodeStatusCursor(token, status string, viewer catalog.Viewer) (statusCursor, error) {
	if token == "" {
		return statusCursor{}, nil
	}
	if len(token) > 1024 {
		return statusCursor{}, errInvalidCursor
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return statusCursor{}, errInvalidCursor
	}
	var result statusCursor
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return statusCursor{}, errInvalidCursor
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF || result.Version != 1 || result.Status != status ||
		result.UserID != viewer.UserID || result.Admin != viewer.IsAdmin || result.ID < 1 {
		return statusCursor{}, errInvalidCursor
	}
	return result, nil
}

// listByStatus returns visible books with the viewer's reading status, most recently
// changed first, as one 50-entry keyset page.
func listByStatus(ctx context.Context, reader *sql.DB, books *catalog.Service, viewer catalog.Viewer,
	status, token string) (catalog.Page[catalog.Book], error) {
	after, err := decodeStatusCursor(token, status, viewer)
	if err != nil {
		return catalog.Page[catalog.Book]{}, err
	}
	admin := 0
	if viewer.IsAdmin {
		admin = 1
	}
	rows, err := reader.QueryContext(ctx, statusBooksQuery, viewer.UserID, status, admin,
		after.ID, after.Updated, pageSize+1)
	if err != nil {
		return catalog.Page[catalog.Book]{}, fmt.Errorf("list %s books: %w", status, err)
	}
	type key struct{ id, updated int64 }
	var keys []key
	for rows.Next() {
		var item key
		if err := rows.Scan(&item.id, &item.updated); err != nil {
			return catalog.Page[catalog.Book]{}, errors.Join(fmt.Errorf("scan %s book: %w", status, err), rows.Close())
		}
		keys = append(keys, item)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return catalog.Page[catalog.Book]{}, fmt.Errorf("list %s books: %w", status, err)
	}
	page := catalog.Page[catalog.Book]{Items: make([]catalog.Book, 0, min(len(keys), pageSize))}
	if len(keys) > pageSize {
		keys = keys[:pageSize]
		last := keys[len(keys)-1]
		encoded, err := json.Marshal(statusCursor{
			Version: 1, Status: status, UserID: viewer.UserID, Admin: viewer.IsAdmin,
			Updated: last.updated, ID: last.id,
		})
		if err != nil {
			return catalog.Page[catalog.Book]{}, fmt.Errorf("encode %s cursor: %w", status, err)
		}
		next := base64.RawURLEncoding.EncodeToString(encoded)
		page.NextCursor = &next
	}
	for _, item := range keys {
		book, err := books.GetBook(ctx, viewer, item.id)
		if errors.Is(err, catalog.ErrNotFound) {
			continue
		}
		if err != nil {
			return catalog.Page[catalog.Book]{}, err
		}
		page.Items = append(page.Items, book)
	}
	return page, nil
}

func (h *handler) bookEntry(book catalog.Book) entry {
	result := entry{
		ID: fmt.Sprintf("urn:pandalibrary:book:%d", book.ID), Title: book.Title,
		Updated: atomTime(book.UpdatedAt), Authors: []person{}, Identifiers: []string{},
	}
	if book.Subtitle != nil && strings.TrimSpace(*book.Subtitle) != "" {
		result.Title += ": " + *book.Subtitle
	}
	for _, author := range book.Authors {
		if author.Role == "author" {
			result.Authors = append(result.Authors, person{Name: author.Name})
		} else {
			result.Contributors = append(result.Contributors, person{Name: author.Name})
		}
	}
	if book.Language != nil {
		result.Language = *book.Language
	}
	if book.Publisher != nil {
		result.Publisher = *book.Publisher
	}
	if book.PublishedDate != nil {
		result.Issued = *book.PublishedDate
	}
	for _, identifier := range book.Identifiers {
		scheme := strings.ToLower(identifier.Scheme)
		if strings.HasPrefix(scheme, "isbn") {
			scheme = "isbn"
		}
		result.Identifiers = append(result.Identifiers, "urn:"+scheme+":"+identifier.Value)
	}
	for _, tag := range book.Tags {
		result.Categories = append(result.Categories, category{Term: tag.Name, Label: tag.Name})
	}
	var summary []string
	if book.Series != nil {
		series := "Series: " + book.Series.Name
		if book.Series.Index != nil {
			series += fmt.Sprintf(" #%g", *book.Series.Index)
		}
		summary = append(summary, series)
	}
	if book.Description != nil && strings.TrimSpace(*book.Description) != "" {
		summary = append(summary, *book.Description)
	}
	if len(summary) > 0 {
		result.Summary = &textConstruct{Type: "text", Value: strings.Join(summary, "\n\n")}
	}
	if book.CoverURL != nil {
		result.Links = append(result.Links,
			link{Rel: relImage, Href: h.href(fmt.Sprintf("/opds/books/%d/cover", book.ID), nil), Type: "image/jpeg"},
			link{Rel: relThumbnail, Href: h.href(fmt.Sprintf("/opds/books/%d/thumbnail", book.ID), nil), Type: "image/jpeg"},
		)
	}
	for _, file := range book.Files {
		mediaType, err := blobstore.ContentType(file.Format)
		if err != nil {
			continue
		}
		result.Links = append(result.Links, link{
			Rel: relAcquisition, Href: h.href(fmt.Sprintf("/opds/books/%d/files/%d", book.ID, file.ID), nil),
			Type: mediaType, Title: strings.ToUpper(file.Format), Length: file.SizeBytes,
		})
	}
	return result
}
