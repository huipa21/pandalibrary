package stats

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

var ErrInvalid = errors.New("invalid stats request")

const (
	maxDays          = 366
	maxBooks         = 1000
	maxZoneIntervals = 20000
	queryTimeout     = 10 * time.Second
)

type Service struct {
	reader *sql.DB
}

func NewService(reader *sql.DB) (*Service, error) {
	if reader == nil {
		return nil, errors.New("stats requires a reader database")
	}
	return &Service{reader: reader}, nil
}

type dayBoundary struct {
	Date  string `json:"date"`
	Start int64  `json:"start"`
	End   int64  `json:"end"`
}

type zoneInterval struct {
	Start  int64 `json:"start"`
	End    int64 `json:"end"`
	Offset int64 `json:"offset"`
}

type calendar struct {
	location *time.Location
	days     []dayBoundary
	toDay    int64
}

func parseCalendar(from, to, timezone string) (calendar, error) {
	invalid := func(detail string) (calendar, error) {
		return calendar{}, fmt.Errorf("%w: %s", ErrInvalid, detail)
	}
	first, err := time.Parse(time.DateOnly, from)
	if err != nil || first.Year() < 1 || first.Format(time.DateOnly) != from {
		return invalid("from must be a YYYY-MM-DD date")
	}
	last, err := time.Parse(time.DateOnly, to)
	if err != nil || last.Year() < 1 || last.Format(time.DateOnly) != to {
		return invalid("to must be a YYYY-MM-DD date")
	}
	// UTC is used only for counting calendar labels, never local-day durations.
	if last.Before(first) || last.Sub(first) >= maxDays*24*time.Hour {
		return invalid("the inclusive range must contain 1 to 366 calendar days")
	}
	location, err := LoadTimezone(timezone)
	if err != nil {
		return calendar{}, err
	}
	result := calendar{location: location, toDay: last.Unix() / 86400}
	for date := first; !date.After(last); date = date.AddDate(0, 0, 1) {
		next := date.AddDate(0, 0, 1)
		result.days = append(result.days, dayBoundary{
			Date:  date.Format(time.DateOnly),
			Start: localMidnight(date, location).UnixMilli(),
			End:   localMidnight(next, location).UnixMilli(),
		})
	}
	return result, nil
}

// LoadTimezone validates and loads a bundled IANA timezone using the stats API rules.
// Errors wrap ErrInvalid.
func LoadTimezone(timezone string) (*time.Location, error) {
	if timezone == "" || timezone == "Local" || len(timezone) > 255 || strings.TrimSpace(timezone) != timezone {
		return nil, fmt.Errorf("%w: timezone must be an IANA timezone", ErrInvalid)
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, fmt.Errorf("%w: timezone must be an IANA timezone", ErrInvalid)
	}
	return location, nil
}

// LocalMidnight returns the first instant of date's calendar day in location.
func LocalMidnight(date time.Time, location *time.Location) time.Time {
	return localMidnight(date, location)
}

func localMidnight(date time.Time, location *time.Location) time.Time {
	// Examine each offset around midnight to handle ambiguous/skipped midnights
	// and even a skipped calendar date. Choose the earliest qualifying instant.
	nominal := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, time.UTC)
	stop := nominal.Add(48 * time.Hour)
	best := stop
	for cursor := nominal.Add(-48 * time.Hour); cursor.Before(stop); {
		local := cursor.In(location)
		_, offset := local.Zone()
		end := nextZoneEnd(local)
		if end.IsZero() || end.After(stop) {
			end = stop
		}
		candidate := nominal.Add(-time.Duration(offset) * time.Second)
		if candidate.Before(cursor) {
			candidate = cursor
		}
		if candidate.Before(end) && candidate.Before(best) {
			best = candidate
		}
		cursor = end
	}
	return best
}

func nextZoneEnd(instant time.Time) time.Time {
	_, end := instant.ZoneBounds()
	// Go's POSIX extension can report day 365 as the end of a leap year,
	// even on day 366. That final offset lasts through the actual UTC year end.
	if !end.IsZero() && !end.After(instant) {
		end = time.Date(instant.UTC().Year()+1, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	return end
}

// Get returns one consistent read snapshot, never raw session rows. Overlarge book
// results fail explicitly instead of silently truncating the dashboard.
func (s *Service) Get(ctx context.Context, viewer Viewer, from, to, timezone string) (Response, error) {
	if viewer.UserID < 1 {
		return Response{}, fmt.Errorf("%w: viewer is invalid", ErrInvalid)
	}
	cal, err := parseCalendar(from, to, timezone)
	if err != nil {
		return Response{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	result := Response{
		Timezone: timezone, From: from, To: to,
		Daily: make([]Day, 0, len(cal.days)), FinishedPerMonth: []FinishedMonth{},
		TimePerBook: []BookTime{},
	}
	dayIndex := make(map[string]int, len(cal.days))
	monthIndex := make(map[string]int)
	for _, day := range cal.days {
		dayIndex[day.Date] = len(result.Daily)
		result.Daily = append(result.Daily, Day{Date: day.Date})
		month := day.Date[:7]
		if _, ok := monthIndex[month]; !ok {
			monthIndex[month] = len(result.FinishedPerMonth)
			result.FinishedPerMonth = append(result.FinishedPerMonth, FinishedMonth{Month: month})
		}
	}
	days, err := json.Marshal(cal.days)
	if err != nil {
		return Response{}, fmt.Errorf("encode stats calendar: %w", err)
	}
	var admin int64
	if viewer.IsAdmin {
		admin = 1
	}
	start, end := cal.days[0].Start, cal.days[len(cal.days)-1].End
	err = db.WithTx(ctx, s.reader, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		daily, err := queries.StatsDaily(ctx, sqlc.StatsDailyParams{
			Days: string(days), UserID: viewer.UserID, IsAdmin: admin,
		})
		if err != nil {
			return fmt.Errorf("aggregate daily stats: %w", err)
		}
		for _, row := range daily {
			result.Daily[dayIndex[row.Date]] = Day{
				Date: row.Date, ActiveSeconds: row.ActiveSeconds, SessionCount: row.SessionCount,
			}
		}
		finished, err := queries.StatsFinishedDays(ctx, sqlc.StatsFinishedDaysParams{
			Days: string(days), UserID: viewer.UserID, IsAdmin: admin,
		})
		if err != nil {
			return fmt.Errorf("aggregate finished stats: %w", err)
		}
		for _, row := range finished {
			result.FinishedPerMonth[monthIndex[row.Date[:7]]].BooksFinished += row.BooksFinished
		}
		books, err := queries.StatsTimePerBook(ctx, sqlc.StatsTimePerBookParams{
			UserID: viewer.UserID, IsAdmin: admin, StartAt: start, EndAt: end, ResultLimit: maxBooks + 1,
		})
		if err != nil {
			return fmt.Errorf("aggregate book stats: %w", err)
		}
		if len(books) > maxBooks {
			return fmt.Errorf("%w: range exceeds 1000 active books; request a smaller range", ErrInvalid)
		}
		for _, row := range books {
			authors := []string{}
			if err := json.Unmarshal([]byte(row.Authors), &authors); err != nil {
				return fmt.Errorf("decode stats authors: %w", err)
			}
			result.TimePerBook = append(result.TimePerBook, BookTime{
				BookID: row.BookID, Title: row.Title, Authors: authors,
				ActiveSeconds: row.ActiveSeconds, SessionCount: row.SessionCount,
			})
		}
		history, err := queries.StatsHistoryBounds(ctx, sqlc.StatsHistoryBoundsParams{
			UserID: viewer.UserID, IsAdmin: admin, EndAt: end,
		})
		if err != nil {
			return fmt.Errorf("find stats history: %w", err)
		}
		zones, err := historyZones(ctx, history.StartAt, history.EndAt, cal.location)
		if err != nil {
			return err
		}
		streaks, err := queries.StatsStreaks(ctx, sqlc.StatsStreaksParams{
			Zones: zones, UserID: viewer.UserID, IsAdmin: admin, ToDay: cal.toDay,
		})
		if err != nil {
			return fmt.Errorf("aggregate stats streaks: %w", err)
		}
		result.Streaks = Streaks{CurrentDays: streaks.CurrentDays, LongestDays: streaks.LongestDays}
		return nil
	})
	if err != nil {
		return Response{}, err
	}
	return result, nil
}

func historyZones(ctx context.Context, start, end int64, location *time.Location) (string, error) {
	zones := []zoneInterval{}
	for start < end {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if len(zones) >= maxZoneIntervals {
			return "", fmt.Errorf("stats history exceeds %d timezone intervals", maxZoneIntervals)
		}
		instant := time.UnixMilli(start).In(location)
		_, offset := instant.Zone()
		next := nextZoneEnd(instant)
		stop := end
		if !next.IsZero() && next.UnixMilli() < stop {
			stop = next.UnixMilli()
		}
		if stop <= start {
			return "", errors.New("stats timezone interval did not advance")
		}
		zones = append(zones, zoneInterval{Start: start, End: stop, Offset: int64(offset) * 1000})
		start = stop
	}
	encoded, err := json.Marshal(zones)
	if err != nil {
		return "", fmt.Errorf("encode stats timezone intervals: %w", err)
	}
	return string(encoded), nil
}
