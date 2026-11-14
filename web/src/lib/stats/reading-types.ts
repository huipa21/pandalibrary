import type { StatsDay } from './types.js';

export interface ReadingHour {
	month: number;
	hour: number;
	active_seconds: number;
	session_count: number;
}

export interface ReadingCompletion {
	book_id: number;
	title: string;
	started_on: string;
	finished_on: string;
	days: number;
}

export interface ReadingStats {
	year: number;
	timezone: string;
	daily: StatsDay[];
	hours: ReadingHour[];
	books: { read: number; read_and_reading: number };
	completions: ReadingCompletion[];
}
