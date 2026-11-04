/** ST1 `GET /api/v1/stats` response. Dates are local `YYYY-MM-DD`, months `YYYY-MM`. */
export interface StatsDay {
	date: string;
	active_seconds: number;
	session_count: number;
}

export interface FinishedMonth {
	month: string;
	books_finished: number;
}

export interface Streaks {
	current_days: number;
	longest_days: number;
}

export interface BookTime {
	book_id: number;
	title: string;
	authors: string[];
	active_seconds: number;
	session_count: number;
}

export interface StatsResponse {
	timezone: string;
	from: string;
	to: string;
	daily: StatsDay[];
	finished_per_month: FinishedMonth[];
	streaks: Streaks;
	time_per_book: BookTime[];
}

export interface DateRange {
	from: string;
	to: string;
}

/** One chart bar; `display` is the formatted value shown in tooltips. */
export interface Bar {
	key: string;
	label: string;
	value: number;
	display: string;
}
