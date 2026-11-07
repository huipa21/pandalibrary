import type { BookSession, ReadingDay } from '../log-api.js';
import { parseDate } from '../format.js';

export interface SessionDayGroup {
	readonly date: string;
	readonly label: string;
	readonly sessions: readonly BookSession[];
}

export type SessionRow =
	| { readonly kind: 'session'; readonly session: BookSession }
	| { readonly kind: 'attempt'; readonly attempt: number; readonly startedAt: string };

export type ChangeTone = 'positive' | 'negative' | 'neutral';
export type ChartMode = 'curve' | 'trace';

export const CHART = { width: 960, height: 260, left: 48, right: 48, top: 20, bottom: 40 } as const;
const PLOT_HEIGHT = CHART.height - CHART.top - CHART.bottom;
const BASELINE = CHART.height - CHART.bottom;
const DAY_MS = 86_400_000;

export interface ChartPoint {
	readonly day: ReadingDay;
	readonly x: number;
	readonly y: number | null;
	readonly minutes: number;
	readonly barY: number;
	readonly barHeight: number;
}

export interface ChartSeries {
	readonly path: string;
	readonly points: readonly ChartPoint[];
	readonly barWidth: number;
	readonly dateTicks: readonly { readonly x: number; readonly date: string }[];
	readonly percentTicks: readonly { readonly y: number; readonly value: number }[];
	readonly minuteTicks: readonly { readonly y: number; readonly value: number }[];
}

function dayKey(date: Date, formatter: Intl.DateTimeFormat): string {
	const parts = formatter.formatToParts(date);
	const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
	const year = get('year');
	const month = get('month');
	const day = get('day');
	if (!year || !month || !day) throw new RangeError('Could not determine the local calendar day.');
	return `${year}-${month}-${day}`;
}

/** Sessions are expected in the newest-first order returned by the API. */
export function groupSessionsByDay(
	sessions: readonly BookSession[],
	timezone: string,
	locale = 'en'
): SessionDayGroup[] {
	const keyFormatter = new Intl.DateTimeFormat('en-CA-u-nu-latn', {
		timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
	});
	const dateFormatter = new Intl.DateTimeFormat(locale, { timeZone: timezone, month: 'short', day: 'numeric' });
	const weekdayFormatter = new Intl.DateTimeFormat(locale, { timeZone: timezone, weekday: 'short' });
	const groups: Array<{ date: string; label: string; sessions: BookSession[] }> = [];
	for (const session of sessions) {
		const date = new Date(session.started_at);
		const key = dayKey(date, keyFormatter);
		let group = groups.at(-1);
		if (!group || group.date !== key) {
			group = { date: key, label: `${dateFormatter.format(date)} ${weekdayFormatter.format(date)}`, sessions: [] };
			groups.push(group);
		}
		group.sessions.push(session);
	}
	return groups;
}

/** A divider follows the oldest visible session of an attempt when the next attempt differs. */
export function attemptDividers(sessions: readonly BookSession[]): SessionRow[] {
	const rows: SessionRow[] = [];
	for (let index = 0; index < sessions.length; index += 1) {
		const session = sessions[index];
		rows.push({ kind: 'session', session });
		const next = sessions[index + 1];
		if (next && next.attempt !== session.attempt) {
			rows.push({ kind: 'attempt', attempt: session.attempt, startedAt: session.started_at });
		}
	}
	return rows;
}

export function changeTone(change: number | null): ChangeTone {
	if (change === null || change === 0) return 'neutral';
	return change > 0 ? 'positive' : 'negative';
}

const CSV_COLUMNS = [
	'started_at', 'ended_at', 'active_seconds', 'start_percentage', 'end_percentage',
	'change', 'source', 'device', 'attempt'
] as const;

function csvCell(value: string | number | null): string {
	const text = value === null ? '' : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function sessionsToCsv(sessions: readonly BookSession[]): string {
	const rows = sessions.map((session) => CSV_COLUMNS.map((column) => csvCell(session[column])).join(','));
	return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

function calendarTime(day: string): number {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError('Invalid chart date.');
	return parseDate(day).getTime();
}

/** Formats a server-provided local calendar day without shifting it to another timezone. */
export function formatCalendarDay(day: string, locale: string, options: Intl.DateTimeFormatOptions = {}): string {
	return new Intl.DateTimeFormat(locale, {
		month: 'short', day: 'numeric', year: 'numeric', ...options, timeZone: 'UTC'
	}).format(new Date(calendarTime(day)));
}

function niceCeiling(value: number): number {
	if (value <= 0) return 1;
	const power = 10 ** Math.floor(Math.log10(value));
	const fraction = value / power;
	return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

function coord(value: number): string {
	return String(Number(value.toFixed(2)));
}

function linePath(points: readonly { x: number; y: number }[], mode: ChartMode): string {
	if (points.length === 0) return '';
	const first = points[0];
	let path = `M ${coord(first.x)} ${coord(first.y)}`;
	if (points.length === 1) return path;
	if (mode === 'trace') {
		for (const point of points.slice(1)) path += ` H ${coord(point.x)} V ${coord(point.y)}`;
		return path;
	}

	const widths = points.slice(1).map((point, index) => point.x - points[index].x);
	const slopes = widths.map((width, index) => (points[index + 1].y - points[index].y) / width);
	const tangents = points.map((_point, index) => {
		if (index === 0) return slopes[0];
		if (index === points.length - 1) return slopes.at(-1)!;
		const previous = slopes[index - 1];
		const next = slopes[index];
		if (previous * next <= 0) return 0;
		const before = widths[index - 1];
		const after = widths[index];
		const w1 = 2 * after + before;
		const w2 = after + 2 * before;
		return (w1 + w2) / (w1 / previous + w2 / next);
	});
	for (let index = 0; index < widths.length; index += 1) {
		const start = points[index];
		const end = points[index + 1];
		const third = widths[index] / 3;
		path += ` C ${coord(start.x + third)} ${coord(start.y + tangents[index] * third)}` +
			` ${coord(end.x - third)} ${coord(end.y - tangents[index + 1] * third)}` +
			` ${coord(end.x)} ${coord(end.y)}`;
	}
	return path;
}

export function chartSeries(days: readonly ReadingDay[], mode: ChartMode, width: number = CHART.width): ChartSeries {
	const plotWidth = width - CHART.left - CHART.right;
	if (!Number.isFinite(width) || plotWidth <= 0) throw new RangeError('Invalid chart width.');
	const dates = days.map((day) => calendarTime(day.date));
	for (let index = 1; index < dates.length; index += 1) {
		if (dates[index] <= dates[index - 1]) throw new RangeError('Chart days must be in ascending order.');
	}
	const first = dates[0] ?? 0;
	const span = ((dates.at(-1) ?? first) - first) / DAY_MS;
	const minutesMax = niceCeiling(Math.max(0, ...days.map((day) => day.seconds / 60)));
	const minimumGap = dates.length > 1
		? Math.min(...dates.slice(1).map((date, index) => (date - dates[index]) / DAY_MS))
		: 0;
	const barWidth = span === 0 ? Math.min(28, plotWidth) : Math.min(28, minimumGap / span * plotWidth * 0.6);
	const points: ChartPoint[] = days.map((day, index) => {
		const x = span === 0 ? CHART.left + plotWidth / 2 : CHART.left + (dates[index] - first) / DAY_MS / span * plotWidth;
		const minutes = day.seconds / 60;
		const barHeight = minutes / minutesMax * PLOT_HEIGHT;
		return {
			day, x, minutes, barHeight, barY: BASELINE - barHeight,
			y: day.max_percentage === null ? null : BASELINE - day.max_percentage * PLOT_HEIGHT
		};
	});
	const linePoints = points.flatMap((point) => point.y === null ? [] : [{ x: point.x, y: point.y }]);
	const dateTicks: Array<{ x: number; date: string }> = [];
	if (points.length > 0) {
		const firstPoint = points[0];
		const lastPoint = points.at(-1)!;
		dateTicks.push({ x: firstPoint.x, date: firstPoint.day.date });
		const minGap = Math.max(72, plotWidth / 7);
		for (const point of points.slice(1, -1)) {
			if (point.x - dateTicks.at(-1)!.x >= minGap && lastPoint.x - point.x >= minGap) {
				dateTicks.push({ x: point.x, date: point.day.date });
			}
		}
		if (points.length > 1 && lastPoint.x - dateTicks.at(-1)!.x >= minGap) {
			dateTicks.push({ x: lastPoint.x, date: lastPoint.day.date });
		}
	}
	const percentTicks = [0, 25, 50, 75, 100].map((value) => ({
		value, y: BASELINE - value / 100 * PLOT_HEIGHT
	}));
	const minuteTicks = [0, 0.5, 1].map((fraction) => ({
		value: minutesMax * fraction, y: BASELINE - fraction * PLOT_HEIGHT
	}));
	return { path: linePath(linePoints, mode), points, barWidth, dateTicks, percentTicks, minuteTicks };
}
