package stats

type BookBucket struct {
	Key   string `json:"key"`
	Count int64  `json:"count"`
}

type RankedAuthor struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

type RankedBook struct {
	BookID  int64    `json:"book_id"`
	Title   string   `json:"title"`
	Authors []string `json:"authors"`
	Value   int64    `json:"value"`
}

type BooksResponse struct {
	Timezone         string         `json:"timezone"`
	TotalBooks       int64          `json:"total_books"`
	AddedOverTime    []BookBucket   `json:"added_over_time"`
	PublicationYears []BookBucket   `json:"publication_years"`
	Genres           []BookBucket   `json:"genres"`
	Languages        []BookBucket   `json:"languages"`
	Formats          []BookBucket   `json:"formats"`
	PageCounts       []BookBucket   `json:"page_counts"`
	TopAuthors       []RankedAuthor `json:"top_authors"`
	LargestBooks     []RankedBook   `json:"largest_books"`
	MostPages        []RankedBook   `json:"most_pages"`
}
