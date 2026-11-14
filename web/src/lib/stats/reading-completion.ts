import type { ReadingCompletion } from './reading-types.js';

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
}

export function completionPoints(
	completions: readonly ReadingCompletion[],
	width = 550,
	height = 180
): CompletionPoint[] {
	const maximum = Math.max(1, ...completions.map((completion) => completion.days));
	return completions.map((completion, index) => ({
		x: completions.length === 1 ? width / 2 : index * width / (completions.length - 1),
		y: height * (1 - completion.days / maximum)
	}));
}

export function steppedPath(points: readonly CompletionPoint[]): string {
	if (!points.length) return '';
	return `M ${points[0].x} ${points[0].y}` +
		points.slice(1).map((point) => ` H ${point.x} V ${point.y}`).join('');
}
