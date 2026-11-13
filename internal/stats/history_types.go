package stats

// HistoryResponse is a local-calendar year of reading, with a bounded page of
// date/book/cycle rows and page-independent aggregates.
type HistoryResponse struct {
	Year       int            `json:"year"`
	Timezone   string         `json:"timezone"`
	Items      []HistoryRow   `json:"items"`
	NextCursor *string        `json:"next_cursor"`
	Summary    HistorySummary `json:"summary"`
}

type HistoryRow struct {
	Date             string   `json:"date"`
	BookID           int64    `json:"book_id"`
	Title            string   `json:"title"`
	Authors          []string `json:"authors"`
	CoverURL         *string  `json:"cover_url"`
	Cycle            int64    `json:"cycle"`
	ActiveSeconds    int64    `json:"active_seconds"`
	SessionCount     int64    `json:"session_count"`
	DayActiveSeconds int64    `json:"day_active_seconds"`
	DaySessionCount  int64    `json:"day_session_count"`
}

// HistorySummary counts distinct visible books with sessions, and local days
// with positive activity. Zero-second sessions still count toward session totals.
type HistorySummary struct {
	Books         int64          `json:"books"`
	ActiveSeconds int64          `json:"active_seconds"`
	SessionCount  int64          `json:"session_count"`
	ActiveDays    int64          `json:"active_days"`
	Months        []HistoryMonth `json:"months"`
	Records       HistoryRecords `json:"records"`
}

type HistoryMonth struct {
	Month         string `json:"month"`
	Books         int64  `json:"books"`
	ActiveSeconds int64  `json:"active_seconds"`
	SessionCount  int64  `json:"session_count"`
}

type HistoryRecords struct {
	BusiestDay            *Day                 `json:"busiest_day"`
	LongestSessionSeconds int64                `json:"longest_session_seconds"`
	MostReadBook          *HistoryMostReadBook `json:"most_read_book"`
}

type HistoryMostReadBook struct {
	BookID       int64  `json:"book_id"`
	Title        string `json:"title"`
	SessionCount int64  `json:"session_count"`
}
