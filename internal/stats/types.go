package stats

// Viewer is the trusted identity supplied by session authentication.
type Viewer struct {
	UserID  int64
	IsAdmin bool
}

// Response is the stable dashboard DTO. Calendar strings are local ISO dates/months.
// Arrays are always non-null; daily and monthly buckets are ascending.
type Response struct {
	Timezone         string          `json:"timezone"`
	From             string          `json:"from"`
	To               string          `json:"to"`
	Daily            []Day           `json:"daily"`
	FinishedPerMonth []FinishedMonth `json:"finished_per_month"`
	Streaks          Streaks         `json:"streaks"`
	TimePerBook      []BookTime      `json:"time_per_book"`
}

type Day struct {
	Date          string `json:"date"`
	ActiveSeconds int64  `json:"active_seconds"`
	SessionCount  int64  `json:"session_count"`
}

type FinishedMonth struct {
	Month         string `json:"month"`
	BooksFinished int64  `json:"books_finished"`
}

// Streaks uses positive-activity local dates from all visible history through To.
// CurrentDays is zero unless To itself has activity.
type Streaks struct {
	CurrentDays int64 `json:"current_days"`
	LongestDays int64 `json:"longest_days"`
}

// BookTime is ordered by active seconds descending, then book ID ascending.
// Authors includes role=author names in catalog position order.
type BookTime struct {
	BookID        int64    `json:"book_id"`
	Title         string   `json:"title"`
	Authors       []string `json:"authors"`
	ActiveSeconds int64    `json:"active_seconds"`
	SessionCount  int64    `json:"session_count"`
}
