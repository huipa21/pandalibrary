package stats

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

//go:embed reading.sql
var readingQuery string

// Reading returns one snapshot of a viewer's visible yearly reading activity.
// As in the existing statistics, a legacy terminal lifecycle without finished_at
// uses updated_at as its completion event. Only Read, not other terminal states,
// is a completion here.
func (s *Service) Reading(ctx context.Context, viewer Viewer, year int, timezone string) (ReadingResponse, error) {
	if viewer.UserID < 1 || year < 1 || year > 9998 {
		return ReadingResponse{}, fmt.Errorf("%w: year must be 1..9998 and viewer must be valid", ErrInvalid)
	}
	cal, err := parseCalendar(fmt.Sprintf("%04d-01-01", year), fmt.Sprintf("%04d-12-31", year), timezone)
	if err != nil {
		return ReadingResponse{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	start, end := cal.days[0].Start, cal.days[len(cal.days)-1].End
	zones, err := historyZones(ctx, start, end, cal.location)
	if err != nil {
		return ReadingResponse{}, err
	}
	days, err := json.Marshal(cal.days)
	if err != nil {
		return ReadingResponse{}, fmt.Errorf("encode reading calendar: %w", err)
	}
	result := ReadingResponse{
		Year: year, Timezone: timezone, Daily: make([]Day, len(cal.days)),
		Hours: make([]ReadingHour, 12*24), Completions: []ReadingCompletion{},
	}
	dayIndex := make(map[string]int, len(cal.days))
	for i, day := range cal.days {
		result.Daily[i].Date = day.Date
		dayIndex[day.Date] = i
	}
	for i := range result.Hours {
		result.Hours[i].Month, result.Hours[i].Hour = i/24+1, i%24
	}
	var admin int64
	if viewer.IsAdmin {
		admin = 1
	}
	var bucketJSON, completionJSON string
	// A single statement keeps activity, counts and completions in one snapshot.
	err = s.reader.QueryRowContext(ctx, readingQuery,
		sql.Named("user_id", viewer.UserID), sql.Named("is_admin", admin),
		sql.Named("days", string(days)), sql.Named("zones", zones),
		sql.Named("start", start), sql.Named("end", end),
		sql.Named("minimum_start", localMidnight(time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC), cal.location).UnixMilli()),
		sql.Named("result_limit", maxBooks+1),
	).Scan(&bucketJSON, &result.Books.Read, &result.Books.ReadAndReading, &completionJSON)
	if err != nil {
		return ReadingResponse{}, fmt.Errorf("aggregate reading stats: %w", err)
	}
	var buckets []struct {
		Day
		Hour int `json:"hour"`
	}
	if err := json.Unmarshal([]byte(bucketJSON), &buckets); err != nil {
		return ReadingResponse{}, fmt.Errorf("decode reading buckets: %w", err)
	}
	for _, bucket := range buckets {
		index, ok := dayIndex[bucket.Date]
		if !ok || bucket.Hour < 0 || bucket.Hour > 23 {
			return ReadingResponse{}, fmt.Errorf("invalid reading bucket")
		}
		result.Daily[index].ActiveSeconds += bucket.ActiveSeconds
		result.Daily[index].SessionCount += bucket.SessionCount
		month := int(bucket.Date[5]-'0')*10 + int(bucket.Date[6]-'0')
		hour := &result.Hours[(month-1)*24+bucket.Hour]
		hour.ActiveSeconds += bucket.ActiveSeconds
		hour.SessionCount += bucket.SessionCount
	}
	var completions []struct {
		BookID         int64  `json:"book_id"`
		Title          string `json:"title"`
		StartedAt      int64  `json:"started_at"`
		EndedAt        int64  `json:"ended_at"`
		FirstSessionAt *int64 `json:"first_session_at"`
		Progress       []struct {
			RecordedAt int64   `json:"recorded_at"`
			Percentage float64 `json:"percentage"`
		} `json:"progress"`
	}
	if err := json.Unmarshal([]byte(completionJSON), &completions); err != nil {
		return ReadingResponse{}, fmt.Errorf("decode reading completions: %w", err)
	}
	if len(completions) > maxBooks {
		return ReadingResponse{}, fmt.Errorf("%w: year exceeds 1000 completed books", ErrInvalid)
	}
	for _, item := range completions {
		first := time.UnixMilli(item.StartedAt).In(cal.location)
		last := time.UnixMilli(item.EndedAt).In(cal.location)
		if first.Year() < 1 || first.Year() > 9999 {
			continue
		}
		// Calendar labels, not elapsed 24-hour periods, handle DST and same-day reads.
		firstDate := time.Date(first.Year(), first.Month(), first.Day(), 0, 0, 0, 0, time.UTC)
		lastDate := time.Date(last.Year(), last.Month(), last.Day(), 0, 0, 0, 0, time.UTC)
		duration := int((lastDate.Unix() - firstDate.Unix()) / 86400)
		if duration < 0 {
			continue
		}
		completion := ReadingCompletion{
			BookID: item.BookID, Title: item.Title, StartedOn: first.Format(time.DateOnly),
			FinishedOn: last.Format(time.DateOnly), Days: duration,
			Progress: []ReadingProgressPoint{},
		}
		if item.FirstSessionAt != nil {
			origin := time.UnixMilli(*item.FirstSessionAt).In(cal.location)
			completion.FirstSessionOn = origin.Format(time.DateOnly)
			originDate := time.Date(origin.Year(), origin.Month(), origin.Day(), 0, 0, 0, 0, time.UTC)
			for _, point := range item.Progress {
				recorded := time.UnixMilli(point.RecordedAt).In(cal.location)
				date := time.Date(recorded.Year(), recorded.Month(), recorded.Day(), 0, 0, 0, 0, time.UTC)
				completion.Progress = append(completion.Progress, ReadingProgressPoint{
					Days:       int((date.Unix() - originDate.Unix()) / 86400),
					Percentage: point.Percentage, RecordedOn: recorded.Format(time.DateOnly),
				})
			}
		}
		result.Completions = append(result.Completions, completion)
	}
	sort.Slice(result.Completions, func(i, j int) bool {
		a, b := result.Completions[i], result.Completions[j]
		if a.FinishedOn != b.FinishedOn {
			return a.FinishedOn < b.FinishedOn
		}
		return a.BookID < b.BookID
	})
	return result, nil
}
