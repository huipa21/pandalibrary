import type { ReadingCompletion, ReadingProgressPoint } from './reading-types.js';

export function orderedCompletions(completions: readonly ReadingCompletion[]): ReadingCompletion[] {
	return completions
		.filter((completion) => Number.isFinite(completion.days) && completion.days >= 0)
		.toSorted((a, b) => a.finished_on.localeCompare(b.finished_on) || a.book_id - b.book_id);
}

export function completionSummary(completions: readonly ReadingCompletion[]) {
	const days = completions.map((completion) => completion.days).toSorted((a, b) => a - b);
	const count = days.length;
	if (!count) return { count, average: null, median: null, fastest: null, slowest: null };
	const middle = Math.floor(count / 2);
	return {
		count,
		average: days.reduce((sum, value) => sum + value / count, 0),
		median: count % 2 ? days[middle] : days[middle - 1] / 2 + days[middle] / 2,
		fastest: days[0],
		slowest: days[count - 1]
	};
}

export interface CompletionPoint {
	x: number;
	y: number;
	progress: ReadingProgressPoint;
}

export function recordedProgress(completion: ReadingCompletion): ReadingProgressPoint[] {
	return (completion.progress ?? [])
		.filter((point) => Number.isFinite(point.days) && point.days >= 0 &&
			Number.isFinite(point.percentage) && point.percentage >= 0 && point.percentage <= 1)
		.toSorted((a, b) => a.days - b.days);
}

export function completionMaximum(completions: readonly ReadingCompletion[]): number {
	return completions.reduce((maximum, completion) =>
		recordedProgress(completion).reduce((value, point) => Math.max(value, point.days), maximum), 0);
}

export function completionPoints(
	completion: ReadingCompletion,
	maximum: number,
	width = 550,
	height = 180
): CompletionPoint[] {
	return recordedProgress(completion).map((progress) => ({
		x: progress.days / Math.max(1, maximum) * width,
		y: height * (1 - progress.percentage),
		progress
	}));
}

export function steppedPath(points: readonly Pick<CompletionPoint, 'x' | 'y'>[]): string {
	if (!points.length) return '';
	return `M ${points[0].x} ${points[0].y}` +
		points.slice(1).map((point) => ` H ${point.x} V ${point.y}`).join('');
}
