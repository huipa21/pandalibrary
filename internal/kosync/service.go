package kosync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/reading"
)

var (
	ErrInvalid             = errors.New("invalid KOReader fields")
	ErrDocument            = errors.New("invalid KOReader document")
	ErrDocumentNotServable = errors.New("unservable KOReader document")
)

const MaxRequestBytes = 32 << 10

// Record preserves KOReader's opaque position; timestamps on the wire are seconds.
type Record struct {
	Document   string  `json:"document"`
	Progress   string  `json:"progress"`
	Percentage float64 `json:"percentage"`
	Device     string  `json:"device"`
	DeviceID   string  `json:"device_id"`
	Timestamp  float64 `json:"timestamp"`
}

// Input contains the fields accepted by KOReader's progress PUT.
type Input struct {
	Document   string   `json:"document"`
	Progress   *string  `json:"progress"`
	Percentage *float64 `json:"percentage"`
	Device     *string  `json:"device"`
	DeviceID   string   `json:"device_id"`
}

// Options gates chapter-level positions until compatibility is verified on devices.
type Options struct {
	ChapterXPointer bool
}

type Service struct {
	writer  *sql.DB
	reader  *sql.DB
	reading *reading.Service
	options Options
	now     func() time.Time
}

func NewService(writer, reader *sql.DB, state *reading.Service, options Options) (*Service, error) {
	if writer == nil || reader == nil || state == nil {
		return nil, errors.New("KOReader sync requires databases and reading service")
	}
	return &Service{writer: writer, reader: reader, reading: state, options: options, now: time.Now}, nil
}

func validDocument(document string) bool {
	if len(document) < 1 || len(document) > 64 {
		return false
	}
	for _, c := range document {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_') {
			return false
		}
	}
	return true
}

func validString(value string, limit int) bool {
	return len(value) <= limit && utf8.ValidString(value) && !strings.ContainsRune(value, 0)
}

func (input Input) validate() error {
	if !validDocument(input.Document) {
		if len(input.Document) >= 1 && len(input.Document) <= 64 {
			return ErrDocumentNotServable
		}
		return ErrDocument
	}
	if input.Progress == nil || *input.Progress == "" || !validString(*input.Progress, 8<<10) ||
		input.Percentage == nil || math.IsNaN(*input.Percentage) || math.IsInf(*input.Percentage, 0) ||
		*input.Percentage < 0 || *input.Percentage > 1 || input.Device == nil ||
		!validString(*input.Device, 128) || !validString(input.DeviceID, 128) {
		return ErrInvalid
	}
	return nil
}

type file struct {
	id     int64
	bookID int64
	format string
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func visibleFile(ctx context.Context, database queryer, viewer reading.Viewer, document string) (file, error) {
	var result file
	err := database.QueryRowContext(ctx, `
		SELECT f.id, f.book_id, f.format FROM book_files f
		WHERE f.koreader_md5 = ?
		AND (? OR EXISTS (SELECT 1 FROM library_access a JOIN books b ON b.library_id = a.library_id
			WHERE b.id = f.book_id AND a.user_id = ?))
		AND NOT EXISTS (SELECT 1 FROM book_hidden h WHERE h.book_id = f.book_id AND h.user_id = ?)
		ORDER BY f.id LIMIT 1`, document, viewer.IsAdmin, viewer.UserID, viewer.UserID).
		Scan(&result.id, &result.bookID, &result.format)
	return result, err
}

func rawRecord(ctx context.Context, database queryer, userID int64, document string) (*Record, int64, error) {
	record := &Record{Document: document}
	var updatedAt int64
	err := database.QueryRowContext(ctx, `SELECT progress, percentage, device, device_id, updated_at
		FROM kosync_progress WHERE user_id = ? AND document = ?`, userID, document).
		Scan(&record.Progress, &record.Percentage, &record.Device, &record.DeviceID, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, fmt.Errorf("read raw KOReader progress: %w", err)
	}
	record.Timestamp = float64(updatedAt) / 1000
	return record, updatedAt, nil
}

// Put commits the raw record, reading mutation and server session together.
func (s *Service) Put(ctx context.Context, viewer reading.Viewer, input Input) (Record, error) {
	if viewer.UserID < 1 {
		return Record{}, ErrInvalid
	}
	if err := input.validate(); err != nil {
		return Record{}, err
	}
	var record Record
	err := db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		now := s.now().UnixMilli()
		record = Record{input.Document, *input.Progress, *input.Percentage, *input.Device, input.DeviceID, float64(now) / 1000}
		if _, err := tx.ExecContext(ctx, `INSERT INTO kosync_progress
			(user_id, document, progress, percentage, device, device_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (user_id, document) DO UPDATE SET progress=excluded.progress,
			percentage=excluded.percentage, device=excluded.device, device_id=excluded.device_id, updated_at=excluded.updated_at`,
			viewer.UserID, record.Document, record.Progress, record.Percentage, record.Device, record.DeviceID, now); err != nil {
			return fmt.Errorf("write raw KOReader progress: %w", err)
		}
		target, err := visibleFile(ctx, tx, viewer, record.Document)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("resolve KOReader document: %w", err)
		}
		var locator any = map[string]string{"xpointer": record.Progress}
		if target.format == "pdf" || target.format == "cbz" {
			page, err := strconv.ParseInt(record.Progress, 10, 64)
			if err != nil || page < 1 {
				return ErrInvalid
			}
			locator = map[string]int64{"page": page}
		}
		encodedLocator, err := json.Marshal(locator)
		if err != nil {
			return fmt.Errorf("encode KOReader locator: %w", err)
		}
		// JSON escaping can expand an otherwise bounded XPointer past R1's locator limit.
		if len(encodedLocator) > 16<<10 {
			return ErrInvalid
		}
		data, err := json.Marshal(struct {
			BookFileID int64           `json:"book_file_id"`
			Source     string          `json:"source"`
			Locator    json.RawMessage `json:"locator"`
			Percentage float64         `json:"percentage"`
			Device     string          `json:"device"`
			DeviceID   string          `json:"device_id"`
		}{target.id, "koreader", encodedLocator, record.Percentage, record.Device, record.DeviceID})
		if err != nil {
			return fmt.Errorf("encode KOReader reading mutation: %w", err)
		}
		response, err := s.reading.PushTx(ctx, tx, viewer, reading.PushRequest{Mutations: []reading.Mutation{{
			Entity: "reading_progress", ID: strconv.FormatInt(target.bookID, 10), Op: "upsert",
			Data: data, UpdatedAt: &now,
		}}})
		if err != nil {
			return err
		}
		if response.Results[0].Status == "rejected" {
			return fmt.Errorf("KOReader reading mutation rejected: %s", response.Results[0].Reason)
		}
		return extendSession(ctx, tx, viewer.UserID, target, record, now)
	})
	return record, err
}

// Get uses a single snapshot, and never derives positions from inaccessible books.
func (s *Service) Get(ctx context.Context, viewer reading.Viewer, document string) (_ *Record, returnErr error) {
	if viewer.UserID < 1 {
		return nil, ErrInvalid
	}
	if !validDocument(document) {
		if len(document) >= 1 && len(document) <= 64 {
			return nil, ErrDocumentNotServable
		}
		return nil, ErrDocument
	}
	tx, err := s.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("begin KOReader snapshot: %w", err)
	}
	defer func() {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			returnErr = errors.Join(returnErr, err)
		}
	}()
	raw, rawTime, err := rawRecord(ctx, tx, viewer.UserID, document)
	if err != nil {
		return nil, err
	}
	target, err := visibleFile(ctx, tx, viewer, document)
	if errors.Is(err, sql.ErrNoRows) {
		return raw, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve KOReader document: %w", err)
	}
	admin := int64(0)
	if viewer.IsAdmin {
		admin = 1
	}
	progress, err := sqlc.New(tx).ReadingGetProgress(ctx, sqlc.ReadingGetProgressParams{
		UserID: viewer.UserID, BookID: target.bookID, IsAdmin: admin,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return raw, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read bridged KOReader progress: %w", err)
	}
	if progress.UpdatedAt <= rawTime || progress.Source != "web" {
		return raw, nil
	}
	result := &Record{Document: document, Percentage: progress.Percentage, Device: "PandaLibrary Web",
		Timestamp: float64(progress.UpdatedAt) / 1000}
	// Locators are meaningful only for the exact physical file.
	var locator struct {
		Page  *int64 `json:"page"`
		Spine *int64 `json:"spine"`
	}
	if progress.BookFileID.Valid && progress.BookFileID.Int64 == target.id && progress.Locator.Valid {
		if err := json.Unmarshal([]byte(progress.Locator.String), &locator); err != nil {
			// R1 accepts opaque JSON locators, including values not usable by KOReader.
			locator.Page, locator.Spine = nil, nil
		}
	}
	if target.format == "pdf" || target.format == "cbz" {
		if locator.Page == nil || *locator.Page < 1 {
			return raw, nil
		}
		result.Progress = strconv.FormatInt(*locator.Page, 10)
	} else if s.options.ChapterXPointer && locator.Spine != nil && *locator.Spine >= 0 && *locator.Spine < math.MaxInt64 {
		result.Progress = fmt.Sprintf("/body/DocFragment[%d]/body", *locator.Spine+1)
	} else {
		if raw == nil {
			return nil, nil
		}
		result.Progress = raw.Progress
	}
	return result, nil
}
