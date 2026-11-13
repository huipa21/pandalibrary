package catalog

import (
	"bytes"
	"encoding/json"
	"time"
)

// Viewer is the trusted identity used to evaluate catalog visibility.
type Viewer struct {
	UserID  int64
	IsAdmin bool
}

// PageOptions specifies a bounded keyset page.
type PageOptions struct {
	Limit  int
	Cursor string
}

// Page is the JSON list envelope. Items is an array and NextCursor is null at the end.
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// Library is an accessible library with its viewer-visible book count and UTC timestamps.
type Library struct {
	VisibleBookCount int64     `json:"visible_book_count"`
	ID               int64     `json:"id"`
	Name             string    `json:"name"`
	Slug             string    `json:"slug"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// Author is a book's ordered author or contributor.
type Author struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Position int64  `json:"position"`
}

// Series is a book's series; Index is null when no decimal position is known.
type Series struct {
	ID    int64    `json:"id"`
	Name  string   `json:"name"`
	Index *float64 `json:"index"`
}

// Tag is a catalog tag.
type Tag struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// Identifier is a bibliographic identifier.
type Identifier struct {
	Scheme string `json:"scheme"`
	Value  string `json:"value"`
}

// BookFile is the public representation of a stored book format. OriginalFilename
// is always a base name without directories; CreatedAt is the UTC added time.
type BookFile struct {
	ID               int64     `json:"id"`
	Format           string    `json:"format"`
	SizeBytes        int64     `json:"size_bytes"`
	DownloadURL      string    `json:"download_url"`
	OriginalFilename string    `json:"original_filename"`
	CreatedAt        time.Time `json:"created_at"`
	IsDefault        bool      `json:"is_default"`
}

// FieldSource describes provenance. SourceRef and ChosenBy may be null.
type FieldSource struct {
	Field     string    `json:"field"`
	Source    string    `json:"source"`
	SourceRef *string   `json:"source_ref"`
	ChosenBy  *int64    `json:"chosen_by"`
	ChosenAt  time.Time `json:"chosen_at"`
}

// Book is the representation shared by lists and details. Subtitle, Description,
// Language, Publisher, PublishedDate, PageCount, CoverURL, CoverSource, and Series
// may be null; association and field-source collections are always arrays.
type Book struct {
	ID                  int64         `json:"id"`
	OwnerID             *int64        `json:"owner_id"`
	Visibility          string        `json:"visibility"`
	CanManageVisibility bool          `json:"can_manage_visibility"`
	LibraryID           int64         `json:"library_id"`
	Title               string        `json:"title"`
	SortTitle           string        `json:"sort_title"`
	Subtitle            *string       `json:"subtitle"`
	Description         *string       `json:"description"`
	Language            *string       `json:"language"`
	Publisher           *string       `json:"publisher"`
	PublishedDate       *string       `json:"published_date"`
	PageCount           *int64        `json:"page_count"`
	CoverURL            *string       `json:"cover_url"`
	CoverSource         *string       `json:"cover_source"`
	Authors             []Author      `json:"authors"`
	Series              *Series       `json:"series"`
	Tags                []Tag         `json:"tags"`
	Identifiers         []Identifier  `json:"identifiers"`
	Files               []BookFile    `json:"files"`
	FieldSources        []FieldSource `json:"field_sources"`
	CreatedAt           time.Time     `json:"created_at"`
	UpdatedAt           time.Time     `json:"updated_at"`
}

// Entity is an author, series, or tag with a viewer-filtered book count.
// Description is omitted when it is absent.
type Entity struct {
	ID               int64   `json:"id"`
	Name             string  `json:"name"`
	Description      *string `json:"description,omitempty"`
	VisibleBookCount int64   `json:"visible_book_count"`
}

// AccessEntry is an administrator-visible library grant.
type AccessEntry struct {
	UserID    int64     `json:"user_id"`
	GrantedAt time.Time `json:"granted_at"`
}

// HiddenEntry is an administrator-visible hide-list entry; HiddenBy may be null.
type HiddenEntry struct {
	BookID    int64     `json:"book_id"`
	HiddenBy  *int64    `json:"hidden_by"`
	CreatedAt time.Time `json:"created_at"`
}

// BookFilters controls catalog book browsing.
type BookFilters struct {
	LibraryID int64
	AuthorID  int64
	SeriesID  int64
	TagID     int64
	Sort      string
}

// Optional distinguishes an absent PATCH field from an explicit null.
type Optional[T any] struct {
	Set   bool
	Value *T
}

// UnmarshalJSON records explicit nulls and rejects unknown nested object fields.
func (o *Optional[T]) UnmarshalJSON(data []byte) error {
	o.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		o.Value = nil
		return nil
	}
	var value T
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}

// LibraryPatch describes partial library updates.
type LibraryPatch struct {
	Name Optional[string] `json:"name"`
	Slug Optional[string] `json:"slug"`
}

// AuthorInput describes a contributor in a book metadata update.
type AuthorInput struct {
	Name string `json:"name"`
	Role string `json:"role"`
}

// SeriesInput describes a book's series and nullable decimal position.
type SeriesInput struct {
	Name  string   `json:"name"`
	Index *float64 `json:"index"`
}

// BookPatch describes the supported partial book metadata update.
type BookPatch struct {
	LibraryID     Optional[int64]         `json:"library_id"`
	Title         Optional[string]        `json:"title"`
	Subtitle      Optional[string]        `json:"subtitle"`
	Description   Optional[string]        `json:"description"`
	Language      Optional[string]        `json:"language"`
	Publisher     Optional[string]        `json:"publisher"`
	PublishedDate Optional[string]        `json:"published_date"`
	PageCount     Optional[int64]         `json:"page_count"`
	Series        Optional[SeriesInput]   `json:"series"`
	Authors       Optional[[]AuthorInput] `json:"authors"`
	Tags          Optional[[]string]      `json:"tags"`
	Identifiers   Optional[[]Identifier]  `json:"identifiers"`
}
