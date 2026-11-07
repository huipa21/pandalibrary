package reading

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/stats"
)

const (
	attemptCompleteThreshold = 0.95
	attemptRestartThreshold  = 0.10
	maxSummaryDays           = 3660
	defaultSessionPageLimit  = 25
	maxSessionPageLimit      = 100
)

// Session ranges accepted by ListBookSessions.
const (
	SessionRangeAll     = "all"
	SessionRange30Days  = "30d"
	SessionRange90Days  = "90d"
	SessionRangeYear    = "year"
	attemptCompleted    = "completed"
	attemptInProgress   = "in_progress"
	attemptStopped      = "stopped"
	sessionCursorFormat = 1
)

// Session is one recorded reading session with its derived attempt number.
type Session struct {
	ID              string    `json:"id"`
	Source          string    `json:"source"`
	Device          string    `json:"device"`
	StartedAt       time.Time `json:"started_at"`
	EndedAt         time.Time `json:"ended_at"`
	ActiveSeconds   int64     `json:"active_seconds"`
	StartPercentage *float64  `json:"start_percentage"`
	EndPercentage   *float64  `json:"end_percentage"`
	Change          *float64  `json:"change"`
	Attempt         int       `json:"attempt"`
}

// SessionsPage is a newest-first page of a book's sessions.
type SessionsPage struct {
	Items      []Session `json:"items"`
	NextCursor *string   `json:"next_cursor"`
	Total      int64     `json:"total"`
}

// Attempt is one derived read-through of a book.
type Attempt struct {
	Number        int       `json:"number"`
	Status        string    `json:"status"`
	StartedAt     time.Time `json:"started_at"`
	EndedAt       time.Time `json:"ended_at"`
	Sessions      int64     `json:"sessions"`
	Seconds       int64     `json:"seconds"`
	MaxPercentage *float64  `json:"max_percentage"`
	Sources       []string  `json:"sources"`
}

// DayRecord is a duration attributed to one local calendar date.
type DayRecord struct {
	Seconds int64  `json:"seconds"`
	Date    string `json:"date"`
}

// ReadingRecords are a book's personal reading bests.
type ReadingRecords struct {
	LongestSession    *DayRecord `json:"longest_session"`
	BestDay           *DayRecord `json:"best_day"`
	LongestStreakDays int64      `json:"longest_streak_days"`
}

// ReadingDay aggregates one active local calendar date.
type ReadingDay struct {
	Date          string   `json:"date"`
	Seconds       int64    `json:"seconds"`
	Sessions      int64    `json:"sessions"`
	MaxPercentage *float64 `json:"max_percentage"`
}

// ReadingSummary is a user's reading history for one book.
type ReadingSummary struct {
	Progress             float64        `json:"progress"`
	Sessions             int64          `json:"sessions"`
	TotalSeconds         int64          `json:"total_seconds"`
	AverageSeconds       int64          `json:"average_seconds"`
	ActiveDays           int64          `json:"active_days"`
	SpanDays             int64          `json:"span_days"`
	FirstReadAt          *time.Time     `json:"first_read_at"`
	LastReadAt           *time.Time     `json:"last_read_at"`
	PacePercentPerHour   *float64       `json:"pace_percent_per_hour"`
	EstimatedSecondsLeft *int64         `json:"estimated_seconds_left"`
	Records              ReadingRecords `json:"records"`
	Attempts             []Attempt      `json:"attempts"`
	Days                 []ReadingDay   `json:"days"`
}

// attemptSession is the input of the pure attempt derivation, ordered by start time.
type attemptSession struct {
	StartedAt     int64
	EndedAt       int64
	ActiveSeconds int64
	Source        string
	Start         *float64
	End           *float64
}

type sessionRecord struct {
	attemptSession
	Seq    int64
	ID     string
	Device string
}

// deriveAttempts splits chronologically ordered sessions into attempts (oldest first)
// and returns each session's 1-based attempt number. A new attempt starts at a session
// whose start position (end when the start is unknown) is at most 10% after the current
// attempt reached 95%, or at the first session after finishedAt when the current
// attempt began before it.
func deriveAttempts(sessions []attemptSession, finishedAt *int64) ([]Attempt, []int) {
	attempts := []Attempt{}
	numbers := make([]int, len(sessions))
	starts := []int64{}
	sources := []map[string]struct{}{}
	for index, session := range sessions {
		position := session.Start
		if position == nil {
			position = session.End
		}
		if len(attempts) == 0 {
			attempts, starts, sources = appendAttempt(attempts, starts, sources, session.StartedAt)
		} else {
			current := attempts[len(attempts)-1]
			restarted := current.MaxPercentage != nil && *current.MaxPercentage >= attemptCompleteThreshold &&
				position != nil && *position <= attemptRestartThreshold
			afterFinish := finishedAt != nil && session.StartedAt > *finishedAt && starts[len(starts)-1] < *finishedAt
			if restarted || afterFinish {
				attempts, starts, sources = appendAttempt(attempts, starts, sources, session.StartedAt)
			}
		}
		current := &attempts[len(attempts)-1]
		current.Sessions++
		current.Seconds += session.ActiveSeconds
		if session.EndedAt > current.EndedAt.UnixMilli() {
			current.EndedAt = timestamp(session.EndedAt)
		}
		for _, value := range []*float64{session.Start, session.End} {
			if value != nil && (current.MaxPercentage == nil || *value > *current.MaxPercentage) {
				maximum := *value
				current.MaxPercentage = &maximum
			}
		}
		sources[len(sources)-1][session.Source] = struct{}{}
		numbers[index] = current.Number
	}
	for index := range attempts {
		attempt := &attempts[index]
		for source := range sources[index] {
			attempt.Sources = append(attempt.Sources, source)
		}
		sort.Strings(attempt.Sources)
		containsFinish := finishedAt != nil && starts[index] <= *finishedAt &&
			(index == len(attempts)-1 || *finishedAt < starts[index+1])
		switch {
		case attempt.MaxPercentage != nil && *attempt.MaxPercentage >= attemptCompleteThreshold || containsFinish:
			attempt.Status = attemptCompleted
		case index == len(attempts)-1:
			attempt.Status = attemptInProgress
		default:
			attempt.Status = attemptStopped
		}
	}
	return attempts, numbers
}

func appendAttempt(
	attempts []Attempt, starts []int64, sources []map[string]struct{}, startedAt int64,
) ([]Attempt, []int64, []map[string]struct{}) {
	attempts = append(attempts, Attempt{
		Number: len(attempts) + 1, StartedAt: timestamp(startedAt), EndedAt: timestamp(startedAt), Sources: []string{},
	})
	return attempts, append(starts, startedAt), append(sources, map[string]struct{}{})
}

func floatPointer(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}

func loadTimezone(name string) (*time.Location, error) {
	location, err := stats.LoadTimezone(name)
	if err != nil {
		return nil, fmt.Errorf("%w: timezone must be an IANA timezone", ErrInvalid)
	}
	return location, nil
}

func localDate(ms int64, location *time.Location) string {
	return time.UnixMilli(ms).In(location).Format(time.DateOnly)
}

// dateNumber maps a YYYY-MM-DD label to a day count for calendar arithmetic.
func dateNumber(date string) int64 {
	parsed, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return 0
	}
	return int64(math.Floor(float64(parsed.Unix()) / 86400))
}

func (s *Service) loadBookSessions(
	ctx context.Context, q *sqlc.Queries, viewer Viewer, bookID int64,
) ([]sessionRecord, *int64, error) {
	if err := s.requireVisibleBook(ctx, q, viewer, bookID); err != nil {
		return nil, nil, err
	}
	rows, err := q.ReadingListBookSessions(ctx, sqlc.ReadingListBookSessionsParams{
		UserID: viewer.UserID, BookID: bookID,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("list book sessions: %w", err)
	}
	sessions := make([]sessionRecord, 0, len(rows))
	for _, row := range rows {
		sessions = append(sessions, sessionRecord{
			attemptSession: attemptSession{
				StartedAt: row.StartedAt, EndedAt: row.EndedAt, ActiveSeconds: row.ActiveSeconds,
				Source: row.Source, Start: floatPointer(row.StartPercentage), End: floatPointer(row.EndPercentage),
			},
			Seq: row.Seq, ID: row.ID, Device: row.Device,
		})
	}
	var finishedAt *int64
	userBook, err := q.ReadingGetUserBook(ctx, sqlc.ReadingGetUserBookParams{
		UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
	})
	if err == nil {
		finishedAt = nullableInt(userBook.FinishedAt)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, nil, fmt.Errorf("get user book state: %w", err)
	}
	return sessions, finishedAt, nil
}

func attemptInputs(sessions []sessionRecord) []attemptSession {
	inputs := make([]attemptSession, len(sessions))
	for index, session := range sessions {
		inputs[index] = session.attemptSession
	}
	return inputs
}

// GetReadingSummary returns the viewer's reading summary for a visible book.
func (s *Service) GetReadingSummary(ctx context.Context, viewer Viewer, bookID int64, timezone string) (ReadingSummary, error) {
	if err := checkViewer(viewer); err != nil {
		return ReadingSummary{}, err
	}
	if bookID < 1 {
		return ReadingSummary{}, fmt.Errorf("%w: book ID is invalid", ErrInvalid)
	}
	location, err := loadTimezone(timezone)
	if err != nil {
		return ReadingSummary{}, err
	}
	var (
		sessions   []sessionRecord
		finishedAt *int64
		progress   float64
	)
	err = readSnapshot(ctx, s.reader, func(tx *sql.Tx) error {
		q := sqlc.New(tx)
		var err error
		sessions, finishedAt, err = s.loadBookSessions(ctx, q, viewer, bookID)
		if err != nil {
			return err
		}
		row, err := q.ReadingGetProgress(ctx, sqlc.ReadingGetProgressParams{
			UserID: viewer.UserID, BookID: bookID, IsAdmin: adminFlag(viewer),
		})
		if err == nil {
			progress = row.Percentage
		} else if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("get reading progress: %w", err)
		}
		return nil
	})
	if err != nil {
		return ReadingSummary{}, err
	}
	return summarize(sessions, finishedAt, progress, location), nil
}

func summarize(sessions []sessionRecord, finishedAt *int64, progress float64, location *time.Location) ReadingSummary {
	summary := ReadingSummary{
		Progress: math.Min(1, math.Max(0, progress)), Sessions: int64(len(sessions)),
		Attempts: []Attempt{}, Days: []ReadingDay{},
	}
	if len(sessions) == 0 {
		return summary
	}
	attempts, _ := deriveAttempts(attemptInputs(sessions), finishedAt)
	for index := len(attempts) - 1; index >= 0; index-- {
		summary.Attempts = append(summary.Attempts, attempts[index])
	}
	first, last := sessions[0].StartedAt, sessions[0].EndedAt
	var paceProgress float64
	var paceSeconds int64
	days := map[string]*ReadingDay{}
	for _, session := range sessions {
		summary.TotalSeconds += session.ActiveSeconds
		first = min(first, session.StartedAt)
		last = max(last, session.EndedAt)
		if session.Start != nil && session.End != nil {
			paceProgress += math.Max(0, *session.End-*session.Start)
			paceSeconds += session.ActiveSeconds
		}
		date := localDate(session.StartedAt, location)
		if session.ActiveSeconds > 0 &&
			(summary.Records.LongestSession == nil || session.ActiveSeconds > summary.Records.LongestSession.Seconds) {
			summary.Records.LongestSession = &DayRecord{Seconds: session.ActiveSeconds, Date: date}
		}
		day := days[date]
		if day == nil {
			day = &ReadingDay{Date: date}
			days[date] = day
		}
		day.Seconds += session.ActiveSeconds
		day.Sessions++
		for _, value := range []*float64{session.Start, session.End} {
			if value != nil && (day.MaxPercentage == nil || *value > *day.MaxPercentage) {
				maximum := *value
				day.MaxPercentage = &maximum
			}
		}
	}
	summary.AverageSeconds = int64(math.Round(float64(summary.TotalSeconds) / float64(len(sessions))))
	firstAt, lastAt := timestamp(first), timestamp(last)
	summary.FirstReadAt, summary.LastReadAt = &firstAt, &lastAt
	if paceSeconds > 0 {
		pace := paceProgress * 100 / (float64(paceSeconds) / 3600)
		summary.PacePercentPerHour = &pace
		if pace > 0 {
			left := int64(math.Round((1 - summary.Progress) * 100 / pace * 3600))
			summary.EstimatedSecondsLeft = &left
		}
	}

	// Like the stats streaks, a local date is active when it has positive reading time.
	active := make([]ReadingDay, 0, len(days))
	for _, day := range days {
		if day.Seconds > 0 {
			active = append(active, *day)
		}
	}
	sort.Slice(active, func(i, j int) bool { return active[i].Date < active[j].Date })
	summary.ActiveDays = int64(len(active))
	var streak int64
	for index, day := range active {
		if index > 0 && dateNumber(day.Date)-dateNumber(active[index-1].Date) == 1 {
			streak++
		} else {
			streak = 1
		}
		summary.Records.LongestStreakDays = max(summary.Records.LongestStreakDays, streak)
		if summary.Records.BestDay == nil || day.Seconds > summary.Records.BestDay.Seconds {
			summary.Records.BestDay = &DayRecord{Seconds: day.Seconds, Date: day.Date}
		}
	}
	if len(active) > 0 {
		summary.SpanDays = dateNumber(active[len(active)-1].Date) - dateNumber(active[0].Date) + 1
	}
	if len(active) > maxSummaryDays {
		active = active[len(active)-maxSummaryDays:]
	}
	summary.Days = active
	return summary
}

type sessionCursor struct {
	Version   int    `json:"v"`
	UserID    int64  `json:"u"`
	IsAdmin   bool   `json:"a"`
	BookID    int64  `json:"b"`
	Range     string `json:"r"`
	Timezone  string `json:"z"`
	HasSince  bool   `json:"h"`
	Since     int64  `json:"l"`
	StartedAt int64  `json:"t"`
	Seq       int64  `json:"s"`
}

func parseSessionCursor(token string, viewer Viewer, bookID int64, rangeName, timezone string) (sessionCursor, error) {
	invalid := fmt.Errorf("%w: cursor does not match this list", ErrInvalid)
	if len(token) > 4096 {
		return sessionCursor{}, invalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return sessionCursor{}, invalid
	}
	var cursor sessionCursor
	if err := decodeMutationData(raw, &cursor); err != nil || cursor.Version != sessionCursorFormat ||
		cursor.UserID != viewer.UserID || cursor.IsAdmin != viewer.IsAdmin || cursor.BookID != bookID ||
		cursor.Range != rangeName || cursor.Timezone != timezone || cursor.Seq < 1 ||
		!cursor.HasSince && cursor.Since != 0 {
		return sessionCursor{}, invalid
	}
	return cursor, nil
}

func rangeStart(rangeName string, now time.Time, location *time.Location) (int64, bool, error) {
	local := now.In(location)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
	switch rangeName {
	case SessionRangeAll:
		return 0, false, nil
	case SessionRange30Days:
		return stats.LocalMidnight(today.AddDate(0, 0, -29), location).UnixMilli(), true, nil
	case SessionRange90Days:
		return stats.LocalMidnight(today.AddDate(0, 0, -89), location).UnixMilli(), true, nil
	case SessionRangeYear:
		return stats.LocalMidnight(time.Date(local.Year(), 1, 1, 0, 0, 0, 0, time.UTC), location).UnixMilli(), true, nil
	default:
		return 0, false, fmt.Errorf("%w: range must be all, 30d, 90d, or year", ErrInvalid)
	}
}

// ListBookSessions returns a newest-first page of the viewer's sessions for a visible
// book. Attempt numbers are derived over all sessions so they are stable across pages.
func (s *Service) ListBookSessions(
	ctx context.Context, viewer Viewer, bookID int64, rangeName, timezone string, limit int, cursor string,
) (SessionsPage, error) {
	if err := checkViewer(viewer); err != nil {
		return SessionsPage{}, err
	}
	if bookID < 1 {
		return SessionsPage{}, fmt.Errorf("%w: book ID is invalid", ErrInvalid)
	}
	if rangeName == "" {
		rangeName = SessionRangeAll
	}
	if limit == 0 {
		limit = defaultSessionPageLimit
	}
	if limit < 1 || limit > maxSessionPageLimit {
		return SessionsPage{}, fmt.Errorf("%w: limit must be between 1 and 100", ErrInvalid)
	}
	location, err := loadTimezone(timezone)
	if err != nil {
		return SessionsPage{}, err
	}
	since, hasSince, err := rangeStart(rangeName, s.now(), location)
	if err != nil {
		return SessionsPage{}, err
	}
	var after sessionCursor
	if cursor != "" {
		if after, err = parseSessionCursor(cursor, viewer, bookID, rangeName, timezone); err != nil {
			return SessionsPage{}, err
		}
		// Later pages keep the first page's lower bound so the filter does not drift.
		since, hasSince = after.Since, after.HasSince
	}
	page := SessionsPage{Items: []Session{}}
	err = readSnapshot(ctx, s.reader, func(tx *sql.Tx) error {
		q := sqlc.New(tx)
		sessions, finishedAt, err := s.loadBookSessions(ctx, q, viewer, bookID)
		if err != nil {
			return err
		}
		_, numbers := deriveAttempts(attemptInputs(sessions), finishedAt)
		attemptByID := make(map[string]int, len(sessions))
		for index, session := range sessions {
			attemptByID[session.ID] = numbers[index]
		}
		var sinceFlag, cursorFlag int64
		if hasSince {
			sinceFlag = 1
		}
		if cursor != "" {
			cursorFlag = 1
		}
		page.Total, err = q.ReadingCountBookSessions(ctx, sqlc.ReadingCountBookSessionsParams{
			UserID: viewer.UserID, BookID: bookID, HasSince: sinceFlag, Since: since,
		})
		if err != nil {
			return fmt.Errorf("count book sessions: %w", err)
		}
		rows, err := q.ReadingPageBookSessions(ctx, sqlc.ReadingPageBookSessionsParams{
			UserID: viewer.UserID, BookID: bookID, HasSince: sinceFlag, Since: since,
			HasCursor: cursorFlag, CursorStartedAt: after.StartedAt, CursorSeq: after.Seq,
			Limit: int64(limit + 1),
		})
		if err != nil {
			return fmt.Errorf("page book sessions: %w", err)
		}
		hasMore := len(rows) > limit
		if hasMore {
			rows = rows[:limit]
		}
		for _, row := range rows {
			start, end := floatPointer(row.StartPercentage), floatPointer(row.EndPercentage)
			var change *float64
			if start != nil && end != nil {
				value := *end - *start
				change = &value
			}
			page.Items = append(page.Items, Session{
				ID: row.ID, Source: row.Source, Device: row.Device,
				StartedAt: timestamp(row.StartedAt), EndedAt: timestamp(row.EndedAt),
				ActiveSeconds: row.ActiveSeconds, StartPercentage: start, EndPercentage: end,
				Change: change, Attempt: attemptByID[row.ID],
			})
		}
		if hasMore {
			last := rows[len(rows)-1]
			raw, err := json.Marshal(sessionCursor{
				Version: sessionCursorFormat, UserID: viewer.UserID, IsAdmin: viewer.IsAdmin, BookID: bookID,
				Range: rangeName, Timezone: timezone, HasSince: hasSince, Since: since,
				StartedAt: last.StartedAt, Seq: last.Seq,
			})
			if err != nil {
				return fmt.Errorf("encode session cursor: %w", err)
			}
			token := base64.RawURLEncoding.EncodeToString(raw)
			page.NextCursor = &token
		}
		return nil
	})
	if err != nil {
		return SessionsPage{}, err
	}
	return page, nil
}

func validUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
			continue
		}
		if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f' || char >= 'A' && char <= 'F') {
			return false
		}
	}
	return true
}

// DeleteBookSession removes one of the viewer's own sessions for a visible book.
// Sessions are never pulled by clients, so no sync revision is bumped.
func (s *Service) DeleteBookSession(ctx context.Context, viewer Viewer, bookID int64, sessionID string) error {
	if err := checkViewer(viewer); err != nil {
		return err
	}
	if bookID < 1 {
		return fmt.Errorf("%w: book ID is invalid", ErrInvalid)
	}
	if !validUUID(sessionID) {
		return fmt.Errorf("%w: session ID must be a UUID", ErrInvalid)
	}
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		q := sqlc.New(tx)
		if err := s.requireVisibleBook(ctx, q, viewer, bookID); err != nil {
			return err
		}
		rows, err := q.ReadingDeleteBookSession(ctx, sqlc.ReadingDeleteBookSessionParams{
			ID: sessionID, UserID: viewer.UserID, BookID: bookID,
		})
		if err != nil {
			return fmt.Errorf("delete reading session: %w", err)
		}
		if rows == 0 {
			return ErrNotFound
		}
		return nil
	})
}
