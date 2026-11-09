// Package reading implements per-user reading state and offline synchronization.
package reading

import (
	"encoding/json"
	"time"
)

// Viewer is the trusted identity supplied by the authenticated HTTP layer.
type Viewer struct {
	UserID  int64
	IsAdmin bool
}

// UserBook is a user's status and rating for one book.
type UserBook struct {
	Status     string     `json:"status"`
	Rating     *int64     `json:"rating"`
	StartedAt  *time.Time `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	Rev        int64      `json:"rev"`
}

// Progress is a user's latest reading position for one book.
type Progress struct {
	BookFileID *int64          `json:"book_file_id"`
	Source     string          `json:"source"`
	Locator    json.RawMessage `json:"locator"`
	Percentage float64         `json:"percentage"`
	Device     string          `json:"device"`
	DeviceID   string          `json:"device_id"`
	UpdatedAt  time.Time       `json:"updated_at"`
	Rev        int64           `json:"rev"`
}

// Highlight is a live highlight or a sync tombstone.
type Highlight struct {
	ID         string          `json:"id"`
	BookID     int64           `json:"book_id"`
	BookFileID *int64          `json:"book_file_id"`
	Locator    json.RawMessage `json:"locator"`
	Position   float64         `json:"position"`
	Text       string          `json:"text"`
	Color      string          `json:"color"`
	Style      string          `json:"style"`
	Chapter    *string         `json:"chapter"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
	DeletedAt  *time.Time      `json:"deleted_at"`
	Rev        int64           `json:"rev"`
}

// Note is a live note or a sync tombstone.
type Note struct {
	ID          string     `json:"id"`
	BookID      int64      `json:"book_id"`
	HighlightID *string    `json:"highlight_id"`
	Body        string     `json:"body_md"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	DeletedAt   *time.Time `json:"deleted_at"`
	Rev         int64      `json:"rev"`
}

// Setting contains one JSON-valued user preference.
type Setting struct {
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	UpdatedAt time.Time       `json:"updated_at"`
	Rev       int64           `json:"rev"`
}

// Bookmark is a saved reading position, distinct from highlights/notes.
type Bookmark struct {
	ID         string          `json:"id"`
	BookID     int64           `json:"book_id"`
	BookFileID *int64          `json:"book_file_id"`
	Locator    json.RawMessage `json:"locator"`
	Position   float64         `json:"position"`
	Label      string          `json:"label"`
	Chapter    *string         `json:"chapter"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
	DeletedAt  *time.Time      `json:"deleted_at"`
	Rev        int64           `json:"rev"`
}

// PageAnnotation is an inserted PDF annotation or a sync tombstone.
type PageAnnotation struct {
	ID         string          `json:"id"`
	BookID     int64           `json:"book_id"`
	BookFileID *int64          `json:"book_file_id"`
	Kind       string          `json:"kind"`
	Locator    json.RawMessage `json:"locator"`
	Position   float64         `json:"position"`
	Data       json.RawMessage `json:"data"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
	DeletedAt  *time.Time      `json:"deleted_at"`
	Rev        int64           `json:"rev"`
}

// BookState contains only the authenticated user's live state for a visible book.
type BookState struct {
	UserBook        *UserBook        `json:"user_book"`
	Progress        *Progress        `json:"progress"`
	Highlights      []Highlight      `json:"highlights"`
	Bookmarks       []Bookmark       `json:"bookmarks"`
	PageAnnotations []PageAnnotation `json:"page_annotations"`
	Notes           []Note           `json:"notes"`
}

// Mutation is one offline outbox item. Data is validated according to Entity.
type Mutation struct {
	Entity    string          `json:"entity"`
	ID        string          `json:"id,omitempty"`
	Key       string          `json:"key,omitempty"`
	Op        string          `json:"op"`
	Data      json.RawMessage `json:"data"`
	UpdatedAt *int64          `json:"updated_at"`
}

// PushRequest is a bounded batch of offline mutations.
type PushRequest struct {
	Mutations []Mutation `json:"mutations"`
}

// MutationResult reports the outcome for the corresponding request item.
type MutationResult struct {
	Index  int    `json:"index"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

// PushResponse contains exactly one result per input mutation.
type PushResponse struct {
	Results []MutationResult `json:"results"`
}

// PullResponse is a consistent synchronization snapshot.
type PullResponse struct {
	Cursor          int64            `json:"cursor"`
	UserBooks       []UserBookRow    `json:"user_books"`
	Progress        []ProgressRow    `json:"reading_progress"`
	Highlights      []Highlight      `json:"highlights"`
	Bookmarks       []Bookmark       `json:"bookmarks"`
	PageAnnotations []PageAnnotation `json:"page_annotations"`
	Notes           []Note           `json:"notes"`
	Settings        []Setting        `json:"user_settings"`
}

// UserBookRow is a synced user_books row.
type UserBookRow struct {
	BookID     int64      `json:"book_id"`
	Status     string     `json:"status"`
	Rating     *int64     `json:"rating"`
	StartedAt  *time.Time `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	Rev        int64      `json:"rev"`
}

// ProgressRow is a synced reading_progress row.
type ProgressRow struct {
	BookID     int64           `json:"book_id"`
	BookFileID *int64          `json:"book_file_id"`
	Source     string          `json:"source"`
	Locator    json.RawMessage `json:"locator"`
	Percentage float64         `json:"percentage"`
	Device     string          `json:"device"`
	DeviceID   string          `json:"device_id"`
	UpdatedAt  time.Time       `json:"updated_at"`
	Rev        int64           `json:"rev"`
}

// AnnotationResult is one live result from the viewer's annotation search.
type AnnotationResult struct {
	ID        string    `json:"id"`
	BookID    int64     `json:"book_id"`
	Kind      string    `json:"kind"`
	Content   string    `json:"content"`
	Position  float64   `json:"position"`
	CreatedAt time.Time `json:"created_at"`
}

// BookmarkItem is a bookmark with minimal book information for display.
type BookmarkItem struct {
	Bookmark
	Book BookmarkBookSummary `json:"book"`
}

// BookmarkBookSummary is minimal book info for bookmark display.
type BookmarkBookSummary struct {
	ID       int64   `json:"id"`
	Title    string  `json:"title"`
	CoverURL *string `json:"cover_url"`
}

// BookmarkPageOptions scopes a page to a book when BookID is non-zero.
type BookmarkPageOptions struct {
	Limit  int
	Cursor string
	BookID int64
}

// BookmarksListResponse is a paginated response of bookmarks.
type BookmarksListResponse struct {
	Items      []BookmarkItem `json:"items"`
	NextCursor *string        `json:"next_cursor"`
}
