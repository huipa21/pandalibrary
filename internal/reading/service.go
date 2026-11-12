package reading

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

var (
	ErrInvalid  = errors.New("invalid reading request")
	ErrNotFound = errors.New("reading resource not found")
)

const (
	maxPushMutations = 500
	maxSettingBytes  = 64 << 10
	maxLocatorBytes  = 16 << 10
	maxNoteBytes     = 64 << 10
	maxHighlightText = 32 << 10
)

// Service owns reading-state persistence and synchronization.
type Service struct {
	writer *sql.DB
	reader *sql.DB
	now    func() time.Time
}

// NewService constructs a reading service over the shared database pools.
func NewService(writer, reader *sql.DB) (*Service, error) {
	if writer == nil || reader == nil {
		return nil, errors.New("reading requires writer and reader databases")
	}
	return &Service{writer: writer, reader: reader, now: time.Now}, nil
}

func checkViewer(viewer Viewer) error {
	if viewer.UserID < 1 {
		return fmt.Errorf("%w: viewer is invalid", ErrInvalid)
	}
	return nil
}

func adminFlag(viewer Viewer) int64 {
	if viewer.IsAdmin {
		return 1
	}
	return 0
}

func timestamp(ms int64) time.Time {
	return time.UnixMilli(ms).UTC()
}

func nullableInt(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func nullableTime(value sql.NullInt64) *time.Time {
	if !value.Valid {
		return nil
	}
	result := timestamp(value.Int64)
	return &result
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func jsonValue(value sql.NullString) json.RawMessage {
	if !value.Valid || !json.Valid([]byte(value.String)) {
		return nil
	}
	return json.RawMessage(value.String)
}

func toUserBook(row sqlc.UserBook) UserBook {
	return UserBook{
		Status: row.Status, Rating: nullableInt(row.Rating), StartedAt: nullableTime(row.StartedAt),
		ReadingCycle: row.ReadingCycle,
		FinishedAt:   nullableTime(row.FinishedAt), UpdatedAt: timestamp(row.UpdatedAt), Rev: row.Rev,
	}
}

func toUserBookRow(row sqlc.UserBook) UserBookRow {
	return UserBookRow{
		BookID: row.BookID, Status: row.Status, Rating: nullableInt(row.Rating),
		ReadingCycle: row.ReadingCycle,
		StartedAt:    nullableTime(row.StartedAt), FinishedAt: nullableTime(row.FinishedAt),
		UpdatedAt: timestamp(row.UpdatedAt), Rev: row.Rev,
	}
}

func toProgress(row sqlc.ReadingProgress) Progress {
	return Progress{
		BookFileID: nullableInt(row.BookFileID), Source: row.Source,
		Locator: jsonValue(row.Locator), Percentage: row.Percentage,
		Device: row.Device, DeviceID: row.DeviceID, UpdatedAt: timestamp(row.UpdatedAt), Rev: row.Rev,
	}
}

func toProgressRow(row sqlc.ReadingProgress) ProgressRow {
	return ProgressRow{
		BookID: row.BookID, BookFileID: nullableInt(row.BookFileID), Source: row.Source,
		Locator: jsonValue(row.Locator), Percentage: row.Percentage,
		Device: row.Device, DeviceID: row.DeviceID, UpdatedAt: timestamp(row.UpdatedAt), Rev: row.Rev,
	}
}

func toHighlight(row sqlc.Highlight) Highlight {
	return Highlight{
		ID: row.ID, BookID: row.BookID, BookFileID: nullableInt(row.BookFileID),
		Locator: json.RawMessage(row.Locator), Position: row.Position, Text: row.Text, Color: row.Color, Style: row.Style,
		Chapter: nullableString(row.Chapter), CreatedAt: timestamp(row.CreatedAt),
		UpdatedAt: timestamp(row.UpdatedAt), DeletedAt: nullableTime(row.DeletedAt), Rev: row.Rev,
	}
}

func toNote(row sqlc.Note) Note {
	return Note{
		ID: row.ID, BookID: row.BookID, HighlightID: nullableString(row.HighlightID),
		Body: row.BodyMd, CreatedAt: timestamp(row.CreatedAt), UpdatedAt: timestamp(row.UpdatedAt),
		DeletedAt: nullableTime(row.DeletedAt), Rev: row.Rev,
	}
}

func toSetting(row sqlc.UserSetting) Setting {
	return Setting{
		Key: row.Key, Value: json.RawMessage(row.Value), UpdatedAt: timestamp(row.UpdatedAt), Rev: row.Rev,
	}
}

func toBookmark(row sqlc.Bookmark) Bookmark {
	return Bookmark{
		ID: row.ID, BookID: row.BookID, BookFileID: nullableInt(row.BookFileID),
		Locator: json.RawMessage(row.Locator), Position: row.Position, Label: row.Label,
		Chapter: nullableString(row.Chapter), CreatedAt: timestamp(row.CreatedAt),
		UpdatedAt: timestamp(row.UpdatedAt), DeletedAt: nullableTime(row.DeletedAt), Rev: row.Rev,
	}
}

type readTransaction func(*sql.Tx) error

func readSnapshot(ctx context.Context, database *sql.DB, fn readTransaction) (returnErr error) {
	tx, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return fmt.Errorf("begin reading snapshot: %w", err)
	}
	defer func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			returnErr = errors.Join(returnErr, fmt.Errorf("roll back reading snapshot: %w", err))
		}
	}()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit reading snapshot: %w", err)
	}
	return nil
}

// GetBookState returns the authenticated user's live state for a visible book.
func (s *Service) GetBookState(ctx context.Context, viewer Viewer, bookID int64) (BookState, error) {
	var state BookState
	if err := checkViewer(viewer); err != nil {
		return state, err
	}
	if bookID < 1 {
		return state, fmt.Errorf("%w: book ID is invalid", ErrInvalid)
	}
	state.Highlights = []Highlight{}
	state.Bookmarks = []Bookmark{}
	state.PageAnnotations = []PageAnnotation{}
	state.Notes = []Note{}
	err := readSnapshot(ctx, s.reader, func(tx *sql.Tx) error {
		q := sqlc.New(tx)
		args := sqlc.ReadingVisibleBookParams{BookID: bookID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID}
		if _, err := q.ReadingVisibleBook(ctx, args); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return fmt.Errorf("check reading book visibility: %w", err)
		}
		userBook, err := q.ReadingGetUserBook(ctx, sqlc.ReadingGetUserBookParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err == nil {
			value := toUserBook(userBook)
			value.ResumeStatus = heldResumeStatus(userBook)
			state.UserBook = &value
		} else if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("get user book state: %w", err)
		}
		progress, err := q.ReadingGetProgress(ctx, sqlc.ReadingGetProgressParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err == nil {
			value := toProgress(progress)
			state.Progress = &value
		} else if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("get reading progress: %w", err)
		}
		highlights, err := q.ReadingListHighlights(ctx, sqlc.ReadingListHighlightsParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err != nil {
			return fmt.Errorf("list reading highlights: %w", err)
		}
		for _, row := range highlights {
			state.Highlights = append(state.Highlights, toHighlight(row))
		}
		bookmarks, err := q.ReadingListBookmarksByBookID(ctx, sqlc.ReadingListBookmarksByBookIDParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err != nil {
			return fmt.Errorf("list bookmarks: %w", err)
		}
		for _, row := range bookmarks {
			state.Bookmarks = append(state.Bookmarks, toBookmark(row))
		}
		pageAnnotations, err := q.ReadingListPageAnnotations(ctx, sqlc.ReadingListPageAnnotationsParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err != nil {
			return fmt.Errorf("list page annotations: %w", err)
		}
		for _, row := range pageAnnotations {
			state.PageAnnotations = append(state.PageAnnotations, toPageAnnotation(row))
		}
		notes, err := q.ReadingListNotes(ctx, sqlc.ReadingListNotesParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err != nil {
			return fmt.Errorf("list reading notes: %w", err)
		}
		for _, row := range notes {
			state.Notes = append(state.Notes, toNote(row))
		}
		return nil
	})
	return state, err
}

// ListSettings returns the authenticated user's JSON settings.
func (s *Service) ListSettings(ctx context.Context, viewer Viewer) ([]Setting, error) {
	if err := checkViewer(viewer); err != nil {
		return nil, err
	}
	var result []Setting
	err := readSnapshot(ctx, s.reader, func(tx *sql.Tx) error {
		rows, err := sqlc.New(tx).ReadingListSettings(ctx, viewer.UserID)
		if err != nil {
			return fmt.Errorf("list user settings: %w", err)
		}
		result = make([]Setting, 0, len(rows))
		for _, row := range rows {
			result = append(result, toSetting(row))
		}
		return nil
	})
	return result, err
}

// Push applies a validated batch atomically and reports one outcome for every item.
func (s *Service) Push(ctx context.Context, viewer Viewer, request PushRequest) (PushResponse, error) {
	var response PushResponse
	err := db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		var err error
		response, err = s.PushTx(ctx, tx, viewer, request)
		return err
	})
	if err != nil {
		return PushResponse{}, fmt.Errorf("apply reading sync batch: %w", err)
	}
	return response, nil
}

// PushTx applies the same validation and LWW rules in a caller-owned transaction.
// The caller must roll back on error and must not expose results before committing.
func (s *Service) PushTx(ctx context.Context, tx *sql.Tx, viewer Viewer, request PushRequest) (PushResponse, error) {
	if tx == nil {
		return PushResponse{}, errors.New("reading sync requires a transaction")
	}
	response := PushResponse{Results: make([]MutationResult, len(request.Mutations))}
	if err := checkViewer(viewer); err != nil {
		return response, err
	}
	if request.Mutations == nil || len(request.Mutations) > maxPushMutations {
		return response, fmt.Errorf("%w: push must contain between 0 and 500 mutations", ErrInvalid)
	}
	for i, mutation := range request.Mutations {
		response.Results[i].Index = i
		if mutation.UpdatedAt == nil || *mutation.UpdatedAt < 0 ||
			!json.Valid(mutation.Data) || len(mutation.Data) == 0 ||
			(mutation.ID != "") == (mutation.Key != "") {
			return PushResponse{}, fmt.Errorf("%w: mutation %d has an invalid envelope", ErrInvalid, i)
		}
	}
	q := sqlc.New(tx)
	for i, mutation := range request.Mutations {
		status, reason, err := s.applyMutation(ctx, q, tx, viewer, mutation)
		if err != nil {
			return PushResponse{}, fmt.Errorf("apply sync mutation %d: %w", i, err)
		}
		response.Results[i] = MutationResult{Index: i, Status: status, Reason: reason}
	}
	return response, nil
}

type userBookData struct {
	BookID     int64  `json:"book_id"`
	Status     string `json:"status"`
	Rating     *int64 `json:"rating"`
	StartedAt  *int64 `json:"started_at"`
	FinishedAt *int64 `json:"finished_at"`
}

type progressData struct {
	BookID     int64           `json:"book_id"`
	BookFileID *int64          `json:"book_file_id"`
	Source     string          `json:"source"`
	Locator    json.RawMessage `json:"locator"`
	Percentage float64         `json:"percentage"`
	Device     string          `json:"device"`
	DeviceID   string          `json:"device_id"`
}

type highlightData struct {
	BookID     int64           `json:"book_id"`
	BookFileID *int64          `json:"book_file_id"`
	Locator    json.RawMessage `json:"locator"`
	Position   float64         `json:"position"`
	Text       string          `json:"text"`
	Color      string          `json:"color"`
	Style      *string         `json:"style"`
	Chapter    *string         `json:"chapter"`
	CreatedAt  *int64          `json:"created_at"`
}

type noteData struct {
	BookID      int64   `json:"book_id"`
	HighlightID *string `json:"highlight_id"`
	Body        string  `json:"body_md"`
	CreatedAt   *int64  `json:"created_at"`
}

type settingData struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

type sessionData struct {
	BookID          int64    `json:"book_id"`
	Source          string   `json:"source"`
	Device          string   `json:"device"`
	StartedAt       int64    `json:"started_at"`
	EndedAt         int64    `json:"ended_at"`
	ActiveSeconds   int64    `json:"active_seconds"`
	StartPercentage *float64 `json:"start_percentage"`
	EndPercentage   *float64 `json:"end_percentage"`
	PagesTurned     *int64   `json:"pages_turned"`
}

type bookmarkData struct {
	BookID     int64           `json:"book_id"`
	BookFileID *int64          `json:"book_file_id"`
	Locator    json.RawMessage `json:"locator"`
	Position   float64         `json:"position"`
	Label      string          `json:"label"`
	Chapter    *string         `json:"chapter"`
	CreatedAt  *int64          `json:"created_at"`
}

func decodeMutationData(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err == nil {
		return errors.New("multiple JSON values")
	} else if !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func mutationID(mutation Mutation) string {
	if mutation.ID != "" {
		return mutation.ID
	}
	return mutation.Key
}

func positiveBookID(mutation Mutation, dataBookID int64) (int64, error) {
	if mutation.ID != "" {
		var parsed int64
		if _, err := fmt.Sscan(mutation.ID, &parsed); err != nil || parsed < 1 || fmt.Sprint(parsed) != mutation.ID {
			return 0, errors.New("book identity must be a positive decimal ID")
		}
		if dataBookID != 0 && dataBookID != parsed {
			return 0, errors.New("book identity does not match data")
		}
		return parsed, nil
	}
	var parsed int64
	if _, err := fmt.Sscan(mutation.Key, &parsed); err != nil || parsed < 1 || fmt.Sprint(parsed) != mutation.Key {
		return 0, errors.New("book key must be a positive decimal ID")
	}
	if dataBookID != 0 && dataBookID != parsed {
		return 0, errors.New("book identity does not match data")
	}
	return parsed, nil
}

func validUUIDv7(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' ||
		value[14] != '7' {
		return false
	}
	switch value[19] {
	case '8', '9', 'a', 'A', 'b', 'B':
	default:
		return false
	}
	for i, char := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}

func nullableIntInput(value *int64) sql.NullInt64 {
	if value == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *value, Valid: true}
}

func nullableStringInput(value *string) sql.NullString {
	if value == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *value, Valid: true}
}

func nullableFloatInput(value *float64) sql.NullFloat64 {
	if value == nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: *value, Valid: true}
}

func reject(reason string) (string, string, error) {
	return "rejected", reason, nil
}

func stale() (string, string, error) {
	return "stale", "", nil
}

func applied() (string, string, error) {
	return "applied", "", nil
}

func (s *Service) applyMutation(
	ctx context.Context, q *sqlc.Queries, tx *sql.Tx, viewer Viewer, mutation Mutation,
) (string, string, error) {
	if mutation.Entity == "" {
		return reject("entity is required")
	}
	if mutation.Op != "upsert" && mutation.Op != "delete" {
		return reject("operation is unsupported")
	}
	now := s.now().UTC().UnixMilli()
	updatedAt := min(*mutation.UpdatedAt, now)
	switch mutation.Entity {
	case "user_books":
		if mutation.Op != "upsert" {
			return reject("user_books does not support deletion")
		}
		var data userBookData
		if err := decodeMutationData(mutation.Data, &data); err != nil {
			return reject("user_book data is invalid")
		}
		bookID, err := positiveBookID(mutation, data.BookID)
		if err != nil {
			return reject(err.Error())
		}
		switch data.Status {
		case "unread", "want_to_read", "reading", "on_hold", "rereading", "finished", "skimmed", "abandoned":
		default:
			return reject("status is invalid")
		}
		if data.Rating != nil && (*data.Rating < 1 || *data.Rating > 10) {
			return reject("rating must be between 1 and 10")
		}
		if data.StartedAt != nil && *data.StartedAt < 0 || data.FinishedAt != nil && *data.FinishedAt < 0 {
			return reject("reading timestamps must be non-negative")
		}
		if err := s.requireVisibleBook(ctx, q, viewer, bookID); errors.Is(err, ErrNotFound) {
			return reject("book is unavailable")
		} else if err != nil {
			return "", "", err
		}
		clock, exists, err := readClock(ctx, func() (int64, error) {
			return q.ReadingGetUserBookClock(ctx, sqlc.ReadingGetUserBookClockParams{
				UserID: viewer.UserID, BookID: bookID,
			})
		})
		if err != nil {
			return "", "", err
		}
		if exists && updatedAt <= clock {
			return stale()
		}
		previous, err := q.ReadingGetUserBook(ctx, sqlc.ReadingGetUserBookParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("get previous reading status: %w", err)
		}
		progress, err := q.ReadingGetProgress(ctx, sqlc.ReadingGetProgressParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("get lifecycle progress: %w", err)
		}
		hasProgress := err == nil
		latest, err := q.ReadingLatestCycleEnd(ctx, sqlc.ReadingLatestCycleEndParams{
			UserID: viewer.UserID, BookID: bookID,
		})
		if err != nil {
			return "", "", fmt.Errorf("get latest reading cycle: %w", err)
		}
		if reason := validateTransition(previous, data.Status, progress, latest); reason != "" {
			return reject(reason)
		}
		restarting := data.Status == "rereading" && terminalStatus(previous.Status)
		if data.StartedAt == nil {
			data.StartedAt = nullableInt(previous.StartedAt)
		}
		if data.FinishedAt == nil {
			data.FinishedAt = nullableInt(previous.FinishedAt)
		}
		if restarting {
			endedAt, err := archiveCycle(ctx, q, viewer, previous, progress, latest, now)
			if err != nil {
				return "", "", err
			}
			startedAt := max(updatedAt, endedAt+1, latest+1)
			data.StartedAt = &startedAt
			data.FinishedAt = nil
		} else if !initialStatus(data.Status) {
			if data.StartedAt == nil {
				data.StartedAt = &updatedAt
			}
			if terminalStatus(data.Status) {
				if data.FinishedAt == nil {
					data.FinishedAt = &updatedAt
				}
			} else {
				data.FinishedAt = nil
			}
		}
		if terminalStatus(previous.Status) && terminalStatus(data.Status) && previous.FinishedAt.Valid {
			// Switching terminal labels does not create another completion event.
			data.FinishedAt = nullableInt(previous.FinishedAt)
		}
		if initialStatus(data.Status) {
			data.StartedAt = nullableInt(previous.StartedAt)
			data.FinishedAt = nullableInt(previous.FinishedAt)
		}
		rev, err := db.NextRev(ctx, tx)
		if err != nil {
			return "", "", err
		}
		rows, err := q.ReadingUpsertUserBook(ctx, sqlc.ReadingUpsertUserBookParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer), Status: data.Status,
			Rating: nullableIntInput(data.Rating), StartedAt: nullableIntInput(data.StartedAt),
			FinishedAt: nullableIntInput(data.FinishedAt), UpdatedAt: updatedAt, Rev: rev,
		})
		if err == nil && rows == 1 {
			if restarting {
				if err := q.ReadingAdvanceCycle(ctx, sqlc.ReadingAdvanceCycleParams{
					UserID: viewer.UserID, BookID: bookID,
				}); err != nil {
					return "", "", fmt.Errorf("advance reading cycle: %w", err)
				}
			}
			completing := (data.Status == "finished" || data.Status == "skimmed") &&
				(previous.Status != data.Status || !hasProgress)
			if restarting || completing {
				percentage := 1.0
				if restarting {
					percentage = 0
				}
				if err := setLifecycleProgress(ctx, q, tx, viewer, bookID, now, percentage); err != nil {
					return "", "", err
				}
			}
		}
		return writeResult(rows, err)

	case "reading_progress":
		if mutation.Op != "upsert" {
			return reject("reading_progress does not support deletion")
		}
		var data progressData
		if err := decodeMutationData(mutation.Data, &data); err != nil {
			return reject("progress data is invalid")
		}
		bookID, err := positiveBookID(mutation, data.BookID)
		if err != nil {
			return reject(err.Error())
		}
		if data.Source != "web" && data.Source != "koreader" {
			return reject("source is invalid")
		}
		if math.IsNaN(data.Percentage) || math.IsInf(data.Percentage, 0) ||
			data.Percentage < 0 || data.Percentage > 1 {
			return reject("percentage must be between 0 and 1")
		}
		if len(data.Device) > 128 || len(data.DeviceID) > 128 ||
			!validOptionalJSON(data.Locator, maxLocatorBytes) {
			return reject("progress fields are invalid")
		}
		if err := s.requireVisibleBook(ctx, q, viewer, bookID); errors.Is(err, ErrNotFound) {
			return reject("book is unavailable")
		} else if err != nil {
			return "", "", err
		}
		if data.BookFileID != nil {
			if _, err := q.ReadingVisibleBookFile(ctx, sqlc.ReadingVisibleBookFileParams{
				BookID: bookID, BookFileID: *data.BookFileID, UserID: viewer.UserID,
				IsAdmin: adminFlag(viewer),
			}); errors.Is(err, sql.ErrNoRows) {
				return reject("book file is unavailable")
			} else if err != nil {
				return "", "", fmt.Errorf("check progress book file: %w", err)
			}
		}
		clock, exists, err := readClock(ctx, func() (int64, error) {
			return q.ReadingGetProgressClock(ctx, sqlc.ReadingGetProgressClockParams{
				UserID: viewer.UserID, BookID: bookID,
			})
		})
		if err != nil {
			return "", "", err
		}
		if exists && updatedAt <= clock {
			return stale()
		}
		previousProgress, err := q.ReadingGetProgress(ctx, sqlc.ReadingGetProgressParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("get previous progress: %w", err)
		}
		percentage, err := storedProgressPercentage(ctx, q, viewer, bookID, data.Percentage)
		if err != nil {
			return "", "", err
		}
		rev, err := db.NextRev(ctx, tx)
		if err != nil {
			return "", "", err
		}
		rows, err := q.ReadingUpsertProgress(ctx, sqlc.ReadingUpsertProgressParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
			BookFileID: nullableIntInput(data.BookFileID), Source: data.Source,
			Locator: nullableJSONInput(data.Locator), Percentage: percentage,
			Device: data.Device, DeviceID: data.DeviceID, UpdatedAt: updatedAt, Rev: rev,
		})
		if err == nil && rows == 1 {
			if err := updateAutoStatus(ctx, q, tx, viewer, bookID, percentage,
				progressMoved(previousProgress, percentage, data.Locator), now); err != nil {
				return "", "", err
			}
		}
		return writeResult(rows, err)

	case "highlights":
		id := mutationID(mutation)
		if !validUUIDv7(id) {
			return reject("highlight ID must be a UUIDv7")
		}
		owner, err := q.ReadingGetHighlightOwner(ctx, id)
		exists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("check highlight ownership: %w", err)
		}
		if exists && owner != viewer.UserID {
			return reject("highlight is owned by another user")
		}
		var existing sqlc.Highlight
		if exists {
			existing, err = q.ReadingGetOwnedHighlight(ctx, sqlc.ReadingGetOwnedHighlightParams{
				ID: id, UserID: viewer.UserID, IsAdmin: adminFlag(viewer),
			})
			if errors.Is(err, sql.ErrNoRows) {
				return reject("highlight book is unavailable")
			}
			if err != nil {
				return "", "", fmt.Errorf("get owned highlight: %w", err)
			}
			if updatedAt <= existing.UpdatedAt {
				return stale()
			}
		}
		if mutation.Op == "delete" {
			if !exists {
				return reject("highlight does not exist")
			}
			return s.deleteHighlight(ctx, q, tx, viewer, existing, updatedAt)
		}
		var data highlightData
		if err := decodeMutationData(mutation.Data, &data); err != nil {
			return reject("highlight data is invalid")
		}
		style := "highlight"
		if exists {
			style = existing.Style
		}
		if data.Style != nil {
			style = *data.Style
		}
		if data.BookID < 1 || !validOptionalJSON(data.Locator, maxLocatorBytes) ||
			len(data.Locator) == 0 || !json.Valid(data.Locator) ||
			math.IsNaN(data.Position) || math.IsInf(data.Position, 0) || data.Position < 0 || data.Position > 1 ||
			len(data.Text) > maxHighlightText || len(data.Color) == 0 || len(data.Color) > 32 ||
			(style != "highlight" && style != "underline" && style != "strikeout") ||
			data.Chapter != nil && len(*data.Chapter) > 512 {
			return reject("highlight fields are invalid")
		}
		if exists && existing.BookID != data.BookID {
			return reject("highlight cannot be moved to another book")
		}
		if err := s.requireVisibleBook(ctx, q, viewer, data.BookID); errors.Is(err, ErrNotFound) {
			return reject("book is unavailable")
		} else if err != nil {
			return "", "", err
		}
		if data.BookFileID != nil {
			if _, err := q.ReadingVisibleBookFile(ctx, sqlc.ReadingVisibleBookFileParams{
				BookID: data.BookID, BookFileID: *data.BookFileID, UserID: viewer.UserID,
				IsAdmin: adminFlag(viewer),
			}); errors.Is(err, sql.ErrNoRows) {
				return reject("book file is unavailable")
			} else if err != nil {
				return "", "", fmt.Errorf("check highlight book file: %w", err)
			}
		}
		createdAt := now
		if exists {
			createdAt = existing.CreatedAt
		} else if data.CreatedAt != nil {
			if *data.CreatedAt < 0 {
				return reject("created_at must be non-negative")
			}
			createdAt = min(*data.CreatedAt, now)
		}
		rev, err := db.NextRev(ctx, tx)
		if err != nil {
			return "", "", err
		}
		if err := q.ReadingRefreshHighlightNotesFTS(ctx, sql.NullString{String: id, Valid: true}); err != nil {
			return "", "", fmt.Errorf("remove stale note search rows: %w", err)
		}
		rows, err := q.ReadingUpsertHighlight(ctx, sqlc.ReadingUpsertHighlightParams{
			ID: id, UserID: viewer.UserID, BookID: data.BookID, IsAdmin: adminFlag(viewer),
			BookFileID: nullableIntInput(data.BookFileID), Locator: string(data.Locator),
			Position: data.Position, Text: data.Text, Color: data.Color, Style: style,
			Chapter: nullableStringInput(data.Chapter), CreatedAt: createdAt, UpdatedAt: updatedAt,
			Rev: rev,
		})
		if err != nil {
			return "", "", fmt.Errorf("upsert highlight: %w", err)
		}
		if rows != 1 {
			return reject("book is unavailable")
		}
		if err := q.ReadingDeleteHighlightFTS(ctx, id); err != nil {
			return "", "", fmt.Errorf("remove stale highlight search row: %w", err)
		}
		if err := q.ReadingIndexHighlightFTS(ctx, id); err != nil {
			return "", "", fmt.Errorf("index highlight: %w", err)
		}
		if err := q.ReadingReindexHighlightNotesFTS(ctx, sql.NullString{String: id, Valid: true}); err != nil {
			return "", "", fmt.Errorf("reindex notes for highlight: %w", err)
		}
		return applied()

	case "notes":
		id := mutationID(mutation)
		if !validUUIDv7(id) {
			return reject("note ID must be a UUIDv7")
		}
		owner, err := q.ReadingGetNoteOwner(ctx, id)
		exists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("check note ownership: %w", err)
		}
		if exists && owner != viewer.UserID {
			return reject("note is owned by another user")
		}
		var existing sqlc.Note
		if exists {
			existing, err = q.ReadingGetOwnedNote(ctx, sqlc.ReadingGetOwnedNoteParams{
				ID: id, UserID: viewer.UserID, IsAdmin: adminFlag(viewer),
			})
			if errors.Is(err, sql.ErrNoRows) {
				return reject("note book is unavailable")
			}
			if err != nil {
				return "", "", fmt.Errorf("get owned note: %w", err)
			}
			if updatedAt <= existing.UpdatedAt {
				return stale()
			}
		}
		if mutation.Op == "delete" {
			if !exists {
				return reject("note does not exist")
			}
			return s.deleteNote(ctx, q, tx, viewer, existing, updatedAt)
		}
		var data noteData
		if err := decodeMutationData(mutation.Data, &data); err != nil {
			return reject("note data is invalid")
		}
		if data.BookID < 1 || len(data.Body) > maxNoteBytes || !utf8.ValidString(data.Body) {
			return reject("note fields are invalid")
		}
		if exists && existing.BookID != data.BookID {
			return reject("note cannot be moved to another book")
		}
		if err := s.requireVisibleBook(ctx, q, viewer, data.BookID); errors.Is(err, ErrNotFound) {
			return reject("book is unavailable")
		} else if err != nil {
			return "", "", err
		}
		if data.HighlightID != nil {
			highlight, err := q.ReadingGetOwnedHighlight(ctx, sqlc.ReadingGetOwnedHighlightParams{
				ID: *data.HighlightID, UserID: viewer.UserID, IsAdmin: adminFlag(viewer),
			})
			if errors.Is(err, sql.ErrNoRows) {
				return reject("highlight is unavailable")
			}
			if err != nil {
				return "", "", fmt.Errorf("check note highlight: %w", err)
			}
			if highlight.BookID != data.BookID || highlight.DeletedAt.Valid {
				return reject("highlight is unavailable")
			}
		}
		createdAt := now
		if exists {
			createdAt = existing.CreatedAt
		} else if data.CreatedAt != nil {
			if *data.CreatedAt < 0 {
				return reject("created_at must be non-negative")
			}
			createdAt = min(*data.CreatedAt, now)
		}
		rev, err := db.NextRev(ctx, tx)
		if err != nil {
			return "", "", err
		}
		if err := q.ReadingDeleteNoteFTS(ctx, id); err != nil {
			return "", "", fmt.Errorf("remove stale note search row: %w", err)
		}
		rows, err := q.ReadingUpsertNote(ctx, sqlc.ReadingUpsertNoteParams{
			ID: id, UserID: viewer.UserID, BookID: data.BookID, IsAdmin: adminFlag(viewer),
			HighlightID: nullableStringInput(data.HighlightID), BodyMd: data.Body,
			CreatedAt: createdAt, UpdatedAt: updatedAt, Rev: rev,
		})
		if err != nil {
			return "", "", fmt.Errorf("upsert note: %w", err)
		}
		if rows != 1 {
			return reject("book is unavailable")
		}
		if err := q.ReadingIndexNoteFTS(ctx, id); err != nil {
			return "", "", fmt.Errorf("index note: %w", err)
		}
		return applied()

	case "user_settings":
		if mutation.Op != "upsert" {
			return reject("user_settings does not support deletion")
		}
		var data settingData
		if err := decodeMutationData(mutation.Data, &data); err != nil {
			return reject("setting data is invalid")
		}
		key := mutation.Key
		if mutation.ID != "" {
			key = mutation.ID
		}
		if key == "" || len(key) > 128 || strings.TrimSpace(key) != key ||
			strings.ContainsAny(key, "\x00\r\n") || data.Key != "" && data.Key != key ||
			len(data.Value) == 0 || len(data.Value) > maxSettingBytes || !json.Valid(data.Value) {
			return reject("setting key or JSON value is invalid")
		}
		clock, exists, err := readClock(ctx, func() (int64, error) {
			return q.ReadingGetSettingClock(ctx, sqlc.ReadingGetSettingClockParams{
				UserID: viewer.UserID, Key: key,
			})
		})
		if err != nil {
			return "", "", err
		}
		if exists && updatedAt <= clock {
			if updatedAt == clock {
				current, err := q.ReadingGetSetting(ctx, sqlc.ReadingGetSettingParams{
					UserID: viewer.UserID, Key: key,
				})
				if err != nil {
					return "", "", fmt.Errorf("get existing setting: %w", err)
				}
				// A response can be lost after the identical setting was committed.
				if current.Value == string(data.Value) {
					return applied()
				}
			}
			return stale()
		}
		rev, err := db.NextRev(ctx, tx)
		if err != nil {
			return "", "", err
		}
		rows, err := q.ReadingUpsertSetting(ctx, sqlc.ReadingUpsertSettingParams{
			UserID: viewer.UserID, Key: key, Value: string(data.Value), UpdatedAt: updatedAt, Rev: rev,
		})
		return writeResult(rows, err)

	case "reading_sessions":
		if mutation.Op != "upsert" {
			return reject("reading_sessions are append-only")
		}
		id := mutationID(mutation)
		if !validUUIDv7(id) {
			return reject("session ID must be a UUIDv7")
		}
		var data sessionData
		if err := decodeMutationData(mutation.Data, &data); err != nil {
			return reject("session data is invalid")
		}
		if data.BookID < 1 || data.StartedAt < 0 || data.EndedAt < data.StartedAt ||
			data.ActiveSeconds < 0 || data.PagesTurned != nil && *data.PagesTurned < 0 ||
			data.Source != "web" && data.Source != "koreader" ||
			len(data.Device) > 128 || !validOptionalPercentage(data.StartPercentage) ||
			!validOptionalPercentage(data.EndPercentage) {
			return reject("session fields are invalid")
		}
		if err := s.requireVisibleBook(ctx, q, viewer, data.BookID); errors.Is(err, ErrNotFound) {
			return reject("book is unavailable")
		} else if err != nil {
			return "", "", err
		}
		owner, err := q.ReadingGetSessionOwner(ctx, id)
		if err == nil {
			if owner != viewer.UserID {
				return reject("session ID is owned by another user")
			}
			return stale()
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("check session idempotency: %w", err)
		}
		startedAt, endedAt := min(data.StartedAt, now), min(data.EndedAt, now)
		rows, err := q.ReadingInsertSession(ctx, sqlc.ReadingInsertSessionParams{
			ID: id, UserID: viewer.UserID, BookID: data.BookID, IsAdmin: adminFlag(viewer),
			Source: data.Source, Device: data.Device, StartedAt: startedAt, EndedAt: endedAt,
			ActiveSeconds: data.ActiveSeconds, StartPercentage: nullableFloatInput(data.StartPercentage),
			EndPercentage: nullableFloatInput(data.EndPercentage), PagesTurned: nullableIntInput(data.PagesTurned),
			CreatedAt: now,
		})
		if err != nil {
			return "", "", fmt.Errorf("insert reading session: %w", err)
		}
		if rows == 0 {
			return reject("book is unavailable")
		}
		return applied()

	case "page_annotations":
		return s.applyPageAnnotation(ctx, q, tx, viewer, mutation, updatedAt, now)

	case "bookmarks":
		id := mutationID(mutation)
		if !validUUIDv7(id) {
			return reject("bookmark ID must be a UUIDv7")
		}
		owner, err := q.ReadingGetBookmarkOwner(ctx, id)
		exists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("check bookmark ownership: %w", err)
		}
		if exists && owner != viewer.UserID {
			return reject("bookmark is owned by another user")
		}
		var existing sqlc.Bookmark
		if exists {
			existing, err = q.ReadingGetOwnedBookmark(ctx, sqlc.ReadingGetOwnedBookmarkParams{
				ID: id, UserID: viewer.UserID, IsAdmin: adminFlag(viewer),
			})
			if errors.Is(err, sql.ErrNoRows) {
				return reject("bookmark book is unavailable")
			}
			if err != nil {
				return "", "", fmt.Errorf("get owned bookmark: %w", err)
			}
			if updatedAt <= existing.UpdatedAt {
				return stale()
			}
		}
		if mutation.Op == "delete" {
			if !exists {
				return reject("bookmark does not exist")
			}
			if existing.DeletedAt.Valid {
				return stale()
			}
			return s.deleteBookmark(ctx, q, tx, viewer, existing, updatedAt)
		}
		var data bookmarkData
		if err := decodeMutationData(mutation.Data, &data); err != nil {
			return reject("bookmark data is invalid")
		}
		if data.BookID < 1 || data.BookFileID == nil || *data.BookFileID < 1 ||
			len(data.Locator) == 0 || len(data.Locator) > maxLocatorBytes ||
			math.IsNaN(data.Position) || math.IsInf(data.Position, 0) || data.Position < 0 || data.Position > 1 ||
			len(data.Label) > 512 || strings.ContainsRune(data.Label, 0) ||
			data.Chapter != nil && (len(*data.Chapter) > 512 || strings.ContainsRune(*data.Chapter, 0)) {
			return reject("bookmark fields are invalid")
		}
		if exists && existing.BookID != data.BookID {
			return reject("bookmark cannot be moved to another book")
		}
		if err := s.requireVisibleBook(ctx, q, viewer, data.BookID); errors.Is(err, ErrNotFound) {
			return reject("book is unavailable")
		} else if err != nil {
			return "", "", err
		}
		format, err := q.ReadingVisibleBookmarkFileFormat(ctx, sqlc.ReadingVisibleBookmarkFileFormatParams{
			BookID: data.BookID, BookFileID: *data.BookFileID, UserID: viewer.UserID,
			IsAdmin: adminFlag(viewer),
		})
		if errors.Is(err, sql.ErrNoRows) {
			return reject("book file is unavailable")
		}
		if err != nil {
			return "", "", fmt.Errorf("check bookmark book file: %w", err)
		}
		if !validBookmarkLocator(data.Locator, format) {
			return reject("bookmark locator is invalid for the book file")
		}
		createdAt := now
		if exists {
			createdAt = existing.CreatedAt
		} else if data.CreatedAt != nil {
			if *data.CreatedAt < 0 {
				return reject("created_at must be non-negative")
			}
			createdAt = min(*data.CreatedAt, now)
		}
		rev, err := db.NextRev(ctx, tx)
		if err != nil {
			return "", "", err
		}
		rows, err := q.ReadingUpsertBookmark(ctx, sqlc.ReadingUpsertBookmarkParams{
			ID: id, UserID: viewer.UserID, BookID: data.BookID, IsAdmin: adminFlag(viewer),
			BookFileID: nullableIntInput(data.BookFileID), Locator: string(data.Locator),
			Position: data.Position, Label: data.Label, Chapter: nullableStringInput(data.Chapter),
			CreatedAt: createdAt, UpdatedAt: updatedAt, Rev: rev,
		})
		if err != nil {
			return "", "", fmt.Errorf("upsert bookmark: %w", err)
		}
		if rows != 1 {
			return reject("book is unavailable")
		}
		return applied()

	default:
		return reject("entity is unsupported")
	}
}

func (s *Service) requireVisibleBook(ctx context.Context, q *sqlc.Queries, viewer Viewer, bookID int64) error {
	if bookID < 1 {
		return ErrNotFound
	}
	_, err := q.ReadingVisibleBook(ctx, sqlc.ReadingVisibleBookParams{
		BookID: bookID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("check visible book: %w", err)
	}
	return nil
}

func validOptionalJSON(value json.RawMessage, limit int) bool {
	return len(value) == 0 || len(value) <= limit && json.Valid(value)
}

func validOptionalPercentage(value *float64) bool {
	return value == nil || !math.IsNaN(*value) && !math.IsInf(*value, 0) && *value >= 0 && *value <= 1
}

func nullableJSONInput(value json.RawMessage) sql.NullString {
	if len(value) == 0 {
		return sql.NullString{}
	}
	return sql.NullString{String: string(value), Valid: true}
}

func readClock(ctx context.Context, get func() (int64, error)) (int64, bool, error) {
	value, err := get()
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("read sync timestamp: %w", err)
	}
	return value, true, nil
}

func writeResult(rows int64, err error) (string, string, error) {
	if err != nil {
		return "", "", fmt.Errorf("write synced row: %w", err)
	}
	if rows == 0 {
		return stale()
	}
	return applied()
}

func (s *Service) deleteHighlight(
	ctx context.Context, q *sqlc.Queries, tx *sql.Tx, viewer Viewer, highlight sqlc.Highlight, updatedAt int64,
) (string, string, error) {
	if !highlight.DeletedAt.Valid {
		children, err := q.ReadingGetNoteHighlights(ctx, sqlc.ReadingGetNoteHighlightsParams{
			UserID: viewer.UserID, HighlightID: sql.NullString{String: highlight.ID, Valid: true},
		})
		if err != nil {
			return "", "", fmt.Errorf("list notes for highlight cascade: %w", err)
		}
		for _, child := range children {
			rev, err := db.NextRev(ctx, tx)
			if err != nil {
				return "", "", err
			}
			if err := q.ReadingDeleteNoteFTS(ctx, child.ID); err != nil {
				return "", "", fmt.Errorf("remove cascaded note from search: %w", err)
			}
			tombstoneAt := max(updatedAt, child.UpdatedAt)
			if err := q.ReadingTombstoneNote(ctx, sqlc.ReadingTombstoneNoteParams{
				ID: child.ID, UserID: viewer.UserID, UpdatedAt: tombstoneAt, DeletedAt: sql.NullInt64{
					Int64: tombstoneAt, Valid: true,
				}, Rev: rev,
			}); err != nil {
				return "", "", fmt.Errorf("tombstone note for deleted highlight: %w", err)
			}
		}
	}
	rev, err := db.NextRev(ctx, tx)
	if err != nil {
		return "", "", err
	}
	if err := q.ReadingRefreshHighlightNotesFTS(ctx, sql.NullString{String: highlight.ID, Valid: true}); err != nil {
		return "", "", fmt.Errorf("remove highlight notes from search: %w", err)
	}
	rows, err := q.ReadingUpsertHighlight(ctx, sqlc.ReadingUpsertHighlightParams{
		ID: highlight.ID, UserID: viewer.UserID, BookID: highlight.BookID, IsAdmin: adminFlag(viewer),
		BookFileID: highlight.BookFileID, Locator: highlight.Locator, Position: highlight.Position,
		Text: highlight.Text, Color: highlight.Color, Style: highlight.Style, Chapter: highlight.Chapter,
		CreatedAt: highlight.CreatedAt, UpdatedAt: updatedAt,
		DeletedAt: sql.NullInt64{Int64: updatedAt, Valid: true}, Rev: rev,
	})
	if err != nil {
		return "", "", fmt.Errorf("tombstone highlight: %w", err)
	}
	if rows != 1 {
		return reject("book is unavailable")
	}
	if err := q.ReadingDeleteHighlightFTS(ctx, highlight.ID); err != nil {
		return "", "", fmt.Errorf("remove deleted highlight from search: %w", err)
	}
	return applied()
}

func (s *Service) deleteNote(
	ctx context.Context, q *sqlc.Queries, tx *sql.Tx, viewer Viewer, note sqlc.Note, updatedAt int64,
) (string, string, error) {
	rev, err := db.NextRev(ctx, tx)
	if err != nil {
		return "", "", err
	}
	if err := q.ReadingDeleteNoteFTS(ctx, note.ID); err != nil {
		return "", "", fmt.Errorf("remove deleted note from search: %w", err)
	}
	rows, err := q.ReadingUpsertNote(ctx, sqlc.ReadingUpsertNoteParams{
		ID: note.ID, UserID: viewer.UserID, BookID: note.BookID, IsAdmin: adminFlag(viewer),
		HighlightID: note.HighlightID, BodyMd: note.BodyMd, CreatedAt: note.CreatedAt,
		UpdatedAt: updatedAt, DeletedAt: sql.NullInt64{Int64: updatedAt, Valid: true}, Rev: rev,
	})
	if err != nil {
		return "", "", fmt.Errorf("tombstone note: %w", err)
	}
	if rows != 1 {
		return reject("book is unavailable")
	}
	return applied()
}

func (s *Service) deleteBookmark(
	ctx context.Context, q *sqlc.Queries, tx *sql.Tx, viewer Viewer, bookmark sqlc.Bookmark, updatedAt int64,
) (string, string, error) {
	rev, err := db.NextRev(ctx, tx)
	if err != nil {
		return "", "", err
	}
	if err := q.ReadingTombstoneBookmark(ctx, sqlc.ReadingTombstoneBookmarkParams{
		ID: bookmark.ID, UserID: viewer.UserID, UpdatedAt: updatedAt,
		DeletedAt: sql.NullInt64{Int64: updatedAt, Valid: true}, Rev: rev,
	}); err != nil {
		return "", "", fmt.Errorf("tombstone bookmark: %w", err)
	}
	return applied()
}

// Pull returns a consistent snapshot bounded by one high-water sync revision.
func (s *Service) Pull(ctx context.Context, viewer Viewer, cursor int64) (PullResponse, error) {
	result := PullResponse{
		UserBooks: []UserBookRow{}, Progress: []ProgressRow{}, Highlights: []Highlight{},
		Bookmarks: []Bookmark{}, PageAnnotations: []PageAnnotation{}, Notes: []Note{}, Settings: []Setting{},
	}
	if err := checkViewer(viewer); err != nil {
		return result, err
	}
	if cursor < 0 {
		return PullResponse{}, fmt.Errorf("%w: cursor must be non-negative", ErrInvalid)
	}
	err := readSnapshot(ctx, s.reader, func(tx *sql.Tx) error {
		q := sqlc.New(tx)
		highWater, err := q.ReadingSyncHighWater(ctx)
		if err != nil {
			return fmt.Errorf("read sync high-water revision: %w", err)
		}
		if cursor > highWater {
			return fmt.Errorf("%w: cursor is ahead of the server revision", ErrInvalid)
		}
		result.Cursor = highWater
		args := sqlc.ReadingPullUserBooksParams{
			UserID: viewer.UserID, Cursor: cursor, HighWater: highWater, IsAdmin: adminFlag(viewer),
		}
		userBooks, err := q.ReadingPullUserBooks(ctx, args)
		if err != nil {
			return fmt.Errorf("pull user books: %w", err)
		}
		for _, row := range userBooks {
			value := toUserBookRow(row)
			value.ResumeStatus = heldResumeStatus(row)
			result.UserBooks = append(result.UserBooks, value)
		}
		progress, err := q.ReadingPullProgress(ctx, sqlc.ReadingPullProgressParams{
			UserID: viewer.UserID, Cursor: cursor, HighWater: highWater, IsAdmin: adminFlag(viewer),
		})
		if err != nil {
			return fmt.Errorf("pull reading progress: %w", err)
		}
		for _, row := range progress {
			result.Progress = append(result.Progress, toProgressRow(row))
		}
		highlights, err := q.ReadingPullHighlights(ctx, sqlc.ReadingPullHighlightsParams{
			UserID: viewer.UserID, Cursor: cursor, HighWater: highWater, IsAdmin: adminFlag(viewer),
		})
		if err != nil {
			return fmt.Errorf("pull highlights: %w", err)
		}
		for _, row := range highlights {
			result.Highlights = append(result.Highlights, toHighlight(row))
		}
		bookmarks, err := q.ReadingPullBookmarks(ctx, sqlc.ReadingPullBookmarksParams{
			UserID: viewer.UserID, Cursor: cursor, HighWater: highWater, IsAdmin: adminFlag(viewer),
		})
		if err != nil {
			return fmt.Errorf("pull bookmarks: %w", err)
		}
		for _, row := range bookmarks {
			result.Bookmarks = append(result.Bookmarks, toBookmark(row))
		}
		pageAnnotations, err := q.ReadingPullPageAnnotations(ctx, sqlc.ReadingPullPageAnnotationsParams{
			UserID: viewer.UserID, Cursor: cursor, HighWater: highWater, IsAdmin: adminFlag(viewer),
		})
		if err != nil {
			return fmt.Errorf("pull page annotations: %w", err)
		}
		for _, row := range pageAnnotations {
			result.PageAnnotations = append(result.PageAnnotations, toPageAnnotation(row))
		}
		notes, err := q.ReadingPullNotes(ctx, sqlc.ReadingPullNotesParams{
			UserID: viewer.UserID, Cursor: cursor, HighWater: highWater, IsAdmin: adminFlag(viewer),
		})
		if err != nil {
			return fmt.Errorf("pull notes: %w", err)
		}
		for _, row := range notes {
			result.Notes = append(result.Notes, toNote(row))
		}
		settings, err := q.ReadingPullSettings(ctx, sqlc.ReadingPullSettingsParams{
			UserID: viewer.UserID, Cursor: cursor, HighWater: highWater,
		})
		if err != nil {
			return fmt.Errorf("pull settings: %w", err)
		}
		for _, row := range settings {
			result.Settings = append(result.Settings, toSetting(row))
		}
		return nil
	})
	return result, err
}

// SearchAnnotations searches only the viewer's live annotations on visible books.
func (s *Service) SearchAnnotations(
	ctx context.Context, viewer Viewer, query, kind string,
) ([]AnnotationResult, error) {
	if err := checkViewer(viewer); err != nil {
		return nil, err
	}
	switch kind {
	case "", "review", "comment", "book_note", "highlight", "underline", "strikeout", "text", "ink", "image":
	default:
		return nil, fmt.Errorf("%w: annotation kind is invalid", ErrInvalid)
	}
	query = strings.TrimSpace(query)
	if query == "" || utf8.RuneCountInString(query) > 200 {
		return nil, fmt.Errorf("%w: annotation query must contain 1 to 200 characters", ErrInvalid)
	}
	results := make([]AnnotationResult, 0, 100)
	err := readSnapshot(ctx, s.reader, func(tx *sql.Tx) error {
		q := sqlc.New(tx)
		if utf8.RuneCountInString(query) >= 3 {
			phrase := `"` + strings.ReplaceAll(query, `"`, `""`) + `"`
			highlights, err := q.ReadingSearchHighlightsFTS(ctx, sqlc.ReadingSearchHighlightsFTSParams{
				Query: phrase, UserID: viewer.UserID, IsAdmin: adminFlag(viewer), PageSize: 100, Kind: kind,
			})
			if err != nil {
				return fmt.Errorf("search highlight FTS: %w", err)
			}
			for _, row := range highlights {
				results = append(results, AnnotationResult{
					ID: row.ID, BookID: row.BookID, Kind: row.Kind, Content: row.Content,
					Position: row.Position, CreatedAt: timestamp(row.CreatedAt),
				})
			}
			notes, err := q.ReadingSearchNotesFTS(ctx, sqlc.ReadingSearchNotesFTSParams{
				Query: phrase, UserID: viewer.UserID, IsAdmin: adminFlag(viewer), PageSize: 100, Kind: kind,
			})
			if err != nil {
				return fmt.Errorf("search note FTS: %w", err)
			}
			for _, row := range notes {
				results = append(results, AnnotationResult{
					ID: row.ID, BookID: row.BookID, Kind: row.Kind, Content: row.Content,
					Position: float64(row.Position), CreatedAt: timestamp(row.CreatedAt),
				})
			}
		} else {
			pattern := "%" + escapeLike(query) + "%"
			highlights, err := q.ReadingSearchHighlightsLike(ctx, sqlc.ReadingSearchHighlightsLikeParams{
				UserID: viewer.UserID, Pattern: pattern, IsAdmin: adminFlag(viewer), PageSize: 100, Kind: kind,
			})
			if err != nil {
				return fmt.Errorf("search highlights: %w", err)
			}
			for _, row := range highlights {
				results = append(results, AnnotationResult{
					ID: row.ID, BookID: row.BookID, Kind: row.Kind, Content: row.Content,
					Position: row.Position, CreatedAt: timestamp(row.CreatedAt),
				})
			}
			notes, err := q.ReadingSearchNotesLike(ctx, sqlc.ReadingSearchNotesLikeParams{
				UserID: viewer.UserID, Pattern: pattern, IsAdmin: adminFlag(viewer), PageSize: 100, Kind: kind,
			})
			if err != nil {
				return fmt.Errorf("search notes: %w", err)
			}
			for _, row := range notes {
				results = append(results, AnnotationResult{
					ID: row.ID, BookID: row.BookID, Kind: row.Kind, Content: row.Content,
					Position: float64(row.Position), CreatedAt: timestamp(row.CreatedAt),
				})
			}
		}
		// Reviews and inserted text have no FTS index. Literal substring matching
		// also handles CJK phrases without depending on token boundaries.
		rows, err := tx.QueryContext(ctx, `
			SELECT a.id, a.book_id, a.kind, a.content, a.position, a.created_at
			FROM (
				SELECT CAST(id AS TEXT) AS id, book_id, user_id, 'review' AS kind,
					body AS content, 0.0 AS position, created_at
				FROM book_reviews
				UNION ALL
				SELECT id, book_id, user_id, 'text', json_extract(data, '$.text'), position, created_at
				FROM page_annotations WHERE kind = 'text' AND deleted_at IS NULL
			) a JOIN books b ON b.id = a.book_id
			WHERE a.user_id = ? AND a.content LIKE ? ESCAPE '\'
			AND (? = '' OR a.kind = ?)
			AND (? = 1 OR EXISTS (
				SELECT 1 FROM library_access la WHERE la.library_id = b.library_id AND la.user_id = ?
			))
			AND NOT EXISTS (SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = ?)
			ORDER BY a.created_at DESC, a.kind, a.id LIMIT 100`,
			viewer.UserID, "%"+escapeLike(query)+"%", kind, kind, adminFlag(viewer), viewer.UserID, viewer.UserID)
		if err != nil {
			return fmt.Errorf("search reviews and inserted text: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var item AnnotationResult
			var createdAt int64
			if err := rows.Scan(&item.ID, &item.BookID, &item.Kind, &item.Content, &item.Position, &createdAt); err != nil {
				return fmt.Errorf("scan review or inserted text: %w", err)
			}
			item.CreatedAt = timestamp(createdAt)
			results = append(results, item)
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("read reviews and inserted text: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close annotation search rows: %w", err)
		}
		sort.Slice(results, func(i, j int) bool {
			if results[i].CreatedAt.Equal(results[j].CreatedAt) {
				if results[i].Kind == results[j].Kind {
					return results[i].ID < results[j].ID
				}
				return results[i].Kind < results[j].Kind
			}
			return results[i].CreatedAt.After(results[j].CreatedAt)
		})
		if len(results) > 100 {
			results = results[:100]
		}
		for i := range results {
			item := &results[i]
			var cover sql.NullString
			if err := tx.QueryRowContext(ctx, `SELECT title, cover_sha256 FROM books WHERE id = ?`,
				item.BookID).Scan(&item.BookTitle, &cover); err != nil {
				return fmt.Errorf("read annotation book: %w", err)
			}
			if cover.Valid {
				url := fmt.Sprintf("/api/v1/books/%d/cover", item.BookID)
				item.CoverURL = &url
			}
			var fileID sql.NullInt64
			var highlightID sql.NullString
			switch item.Kind {
			case "note":
				if err := tx.QueryRowContext(ctx, `SELECT h.book_file_id, n.highlight_id, COALESCE(h.text, '')
					FROM notes n LEFT JOIN highlights h ON h.id = n.highlight_id AND h.deleted_at IS NULL
					AND h.user_id = n.user_id AND h.book_id = n.book_id
					WHERE n.id = ? AND n.user_id = ?`, item.ID, viewer.UserID).
					Scan(&fileID, &highlightID, &item.Anchor); err != nil {
					return fmt.Errorf("read comment destination: %w", err)
				}
			case "highlight":
				if err := tx.QueryRowContext(ctx, `SELECT book_file_id, id, style FROM highlights WHERE id = ? AND user_id = ?`,
					item.ID, viewer.UserID).Scan(&fileID, &highlightID, &item.Kind); err != nil {
					return fmt.Errorf("read highlight destination: %w", err)
				}
			case "text":
				var locator string
				if err := tx.QueryRowContext(ctx, `SELECT book_file_id, locator FROM page_annotations WHERE id = ? AND user_id = ?`,
					item.ID, viewer.UserID).Scan(&fileID, &locator); err != nil {
					return fmt.Errorf("read inserted text destination: %w", err)
				}
				item.Locator = json.RawMessage(locator)
			}
			if fileID.Valid {
				item.BookFileID = &fileID.Int64
			}
			if highlightID.Valid {
				item.HighlightID = &highlightID.String
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}
