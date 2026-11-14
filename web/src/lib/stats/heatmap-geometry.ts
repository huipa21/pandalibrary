import { addDays, dayNumber, inclusiveDayCount } from './api.js';

export interface CalendarCell {
	date: string;
	week: number;
	weekday: number;
}

/** Calendar rows run Monday–Sunday; partial weeks never include another year's dates. */
export function yearCalendar(year: number): { days: CalendarCell[]; weeks: number } {
	const first = `${String(year).padStart(4, '0')}-01-01`;
	const last = `${String(year).padStart(4, '0')}-12-31`;
	const start = dayNumber(first);
	const count = inclusiveDayCount(first, last);
	if (start === null || count === null) throw new RangeError(`Invalid calendar year: ${year}`);
	const offset = ((start + 3) % 7 + 7) % 7;
	const days = Array.from({ length: count }, (_, index) => ({
		date: addDays(first, index),
		week: Math.floor((index + offset) / 7),
		weekday: (index + offset) % 7
	}));
	return { days, weeks: Math.ceil((count + offset) / 7) };
}
