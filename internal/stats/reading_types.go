package stats

type ReadingResponse struct {
	Year        int                 `json:"year"`
	Timezone    string              `json:"timezone"`
	Daily       []Day               `json:"daily"`
	Hours       []ReadingHour       `json:"hours"`
	Books       ReadingBooks        `json:"books"`
	Completions []ReadingCompletion `json:"completions"`
}

type ReadingHour struct {
	Month         int   `json:"month"`
	Hour          int   `json:"hour"`
	ActiveSeconds int64 `json:"active_seconds"`
	SessionCount  int64 `json:"session_count"`
}

type ReadingBooks struct {
	Read           int64 `json:"read"`
	ReadAndReading int64 `json:"read_and_reading"`
}

type ReadingCompletion struct {
	BookID     int64  `json:"book_id"`
	Title      string `json:"title"`
	StartedOn  string `json:"started_on"`
	FinishedOn string `json:"finished_on"`
	Days       int    `json:"days"`
}
