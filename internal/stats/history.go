package stats

import (
	"bytes"
	"context"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

//go:embed history.sql
var historyQuery string

type historyCursor struct {
	Version  int    `json:"v"`
	Year     int    `json:"year"`
	Timezone string `json:"tz"`
	UserID   int64  `json:"user"`
	Admin    bool   `json:"admin"`
	Date     string `json:"date"`
	BookID   int64  `json:"book"`
	Cycle    int64  `json:"cycle"`
	Latest   int64  `json:"latest"`
}

type historyQueryRow struct {
	HistoryRow
	Latest int64 `json:"_latest"`
}

// History orders rows by date and latest session descending, then book/cycle ascending.
// Cursors contain the complete grouping key and are bound to viewer/year/timezone.
// Reading past completion does not create a cycle: an explicit reread must start.
func (s *Service) History(ctx context.Context, viewer Viewer, year int, timezone string, limit int, cursor string) (HistoryResponse, error) {
	invalid := func(detail string) (HistoryResponse, error) {
		return HistoryResponse{}, fmt.Errorf("%w: %s", ErrInvalid, detail)
	}
	if viewer.UserID < 1 || year < 1 || year > 9998 || limit < 1 || limit > 100 {
		return invalid("year must be 1..9998, limit 1..100, and viewer must be valid")
	}
	cal, err := parseCalendar(fmt.Sprintf("%04d-01-01", year), fmt.Sprintf("%04d-12-31", year), timezone)
	if err != nil {
		return HistoryResponse{}, err
	}
	after := historyCursor{}
	if cursor != "" {
		if len(cursor) > 2048 {
			return invalid("history cursor is invalid")
		}
		data, err := base64.RawURLEncoding.Strict().DecodeString(cursor)
		if err != nil {
			return invalid("history cursor is invalid")
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&after); err != nil {
			return invalid("history cursor is invalid")
		}
		var extra any
		date, dateErr := time.Parse(time.DateOnly, after.Date)
		if decoder.Decode(&extra) != io.EOF || after.Version != 1 || after.Year != year ||
			after.Timezone != timezone || after.UserID != viewer.UserID || after.Admin != viewer.IsAdmin ||
			dateErr != nil || date.Year() != year || date.Format(time.DateOnly) != after.Date ||
			after.BookID < 1 || after.Cycle < 1 {
			return invalid("history cursor is invalid or belongs to another request")
		}
		validInstant := false
		for _, day := range cal.days {
			if day.Date == after.Date && after.Latest >= day.Start && after.Latest < day.End {
				validInstant = true
				break
			}
		}
		if !validInstant {
			return invalid("history cursor timestamp is outside its local date")
		}
	}
	days, err := json.Marshal(cal.days)
	if err != nil {
		return HistoryResponse{}, fmt.Errorf("encode history calendar: %w", err)
	}
	var admin int64
	if viewer.IsAdmin {
		admin = 1
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	// A single statement gives the page, its day totals, and full summaries one snapshot.
	var items, summary string
	err = s.reader.QueryRowContext(ctx, historyQuery,
		sql.Named("days", string(days)), sql.Named("user_id", viewer.UserID), sql.Named("is_admin", admin),
		sql.Named("after_date", after.Date), sql.Named("after_book", after.BookID),
		sql.Named("after_cycle", after.Cycle), sql.Named("after_latest", after.Latest),
		sql.Named("result_limit", limit+1),
	).Scan(&items, &summary)
	if err != nil {
		return HistoryResponse{}, fmt.Errorf("aggregate stats history: %w", err)
	}
	result := HistoryResponse{Year: year, Timezone: timezone, Items: []HistoryRow{}}
	var queryRows []historyQueryRow
	if err := json.Unmarshal([]byte(items), &queryRows); err != nil {
		return HistoryResponse{}, fmt.Errorf("decode history rows: %w", err)
	}
	if err := json.Unmarshal([]byte(summary), &result.Summary); err != nil {
		return HistoryResponse{}, fmt.Errorf("decode history summary: %w", err)
	}
	months := make([]HistoryMonth, 12)
	for i := range months {
		months[i].Month = fmt.Sprintf("%04d-%02d", year, i+1)
	}
	for _, month := range result.Summary.Months {
		parsed, err := time.Parse("2006-01", month.Month)
		if err != nil || parsed.Year() != year {
			return HistoryResponse{}, fmt.Errorf("invalid history month %q", month.Month)
		}
		months[int(parsed.Month())-1] = month
	}
	result.Summary.Months = months
	if len(queryRows) > limit {
		queryRows = queryRows[:limit]
		last := queryRows[len(queryRows)-1]
		data, err := json.Marshal(historyCursor{
			Version: 1, Year: year, Timezone: timezone, UserID: viewer.UserID, Admin: viewer.IsAdmin,
			Date: last.Date, BookID: last.BookID, Cycle: last.Cycle, Latest: last.Latest,
		})
		if err != nil {
			return HistoryResponse{}, fmt.Errorf("encode history cursor: %w", err)
		}
		next := base64.RawURLEncoding.EncodeToString(data)
		result.NextCursor = &next
	}
	for _, row := range queryRows {
		result.Items = append(result.Items, row.HistoryRow)
	}
	return result, nil
}
