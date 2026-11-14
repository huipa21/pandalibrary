export interface BookBucket {
	key: string;
	count: number;
}

export interface RankedAuthor {
	name: string;
	count: number;
}

export interface RankedBook {
	book_id: number;
	title: string;
	authors: string[];
	value: number;
}

export interface BookStatsResponse {
	timezone: string;
	total_books: number;
	added_over_time: BookBucket[];
	publication_years: BookBucket[];
	genres: BookBucket[];
	languages: BookBucket[];
	formats: BookBucket[];
	page_counts: BookBucket[];
	top_authors: RankedAuthor[];
	largest_books: RankedBook[];
	most_pages: RankedBook[];
}

export interface ChartDatum {
	key: string;
	label: string;
	value: number;
	display: string;
}
