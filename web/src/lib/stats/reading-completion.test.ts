import { describe, expect, it } from 'vitest';
import type { ReadingCompletion } from './reading-types.js';
import { completionMaximum, completionPoints, completionSummary, orderedCompletions, recordedProgress, steppedPath } from './reading-completion.js';

function completion(book_id: number, days: number, finished_on = '2026-06-01'): ReadingCompletion {
	return { book_id, title: `Book ${book_id}`, started_on: '2026-05-01', finished_on, days };
}

describe('reading completion race', () => {
	it('orders by finish date then book id without changing backend data', () => {
		const source = [completion(3, 4), completion(2, 0), completion(1, 9, '2026-05-15')];
		expect(orderedCompletions(source).map((book) => book.book_id)).toEqual([1, 2, 3]);
		expect(source.map((book) => book.book_id)).toEqual([3, 2, 1]);
	});

	it('summarizes odd and even durations including same-day zero', () => {
		expect(completionSummary([completion(1, 9), completion(2, 0), completion(3, 3)]))
			.toEqual({ count: 3, average: 4, median: 3, fastest: 0, slowest: 9 });
		expect(completionSummary([completion(1, 0), completion(2, 3)]))
			.toEqual({ count: 2, average: 1.5, median: 1.5, fastest: 0, slowest: 3 });
	});

	it('does not invent durations for missing or invalid values', () => {
		const valid = orderedCompletions([completion(1, NaN), completion(2, -1), completion(3, Infinity)]);
		expect(completionSummary(valid))
			.toEqual({ count: 0, average: null, median: null, fastest: null, slowest: null });
		expect(completionMaximum(valid)).toBe(0);
	});

	it('draws a distinct stepped curve from each book’s actual recorded percentages', () => {
		const first = { ...completion(1, 12), progress: [
			{ days: 0, percentage: 0.25, recorded_on: '2026-05-01' },
			{ days: 2, percentage: 0.5, recorded_on: '2026-05-03' },
			{ days: 4, percentage: 0.75, recorded_on: '2026-05-05' }
		] };
		const second = { ...completion(2, 8), progress: [
			{ days: 0, percentage: 0.5, recorded_on: '2026-05-01' },
			{ days: 2, percentage: 0.25, recorded_on: '2026-05-03' }
		] };
		const maximum = completionMaximum([first, second]);
		expect(maximum).toBe(4);
		const points = completionPoints(first, maximum, 100, 80);
		expect(points.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 0, y: 60 }, { x: 50, y: 40 }, { x: 100, y: 20 }]);
		expect(steppedPath(points)).toBe('M 0 60 H 50 V 40 H 100 V 20');
		expect(steppedPath(completionPoints(second, maximum, 100, 80))).toBe('M 0 40 H 50 V 60');
		expect(points.map((point) => point.progress)).toEqual(first.progress);
	});

	it('keeps same-day observations and zero percentages without synthetic endpoints', () => {
		const book = { ...completion(1, 0), progress: [
			{ days: 0, percentage: 0, recorded_on: '2026-05-01' },
			{ days: 0, percentage: 0.5, recorded_on: '2026-05-01' }
		] };
		expect(steppedPath(completionPoints(book, 0, 100, 80))).toBe('M 0 80 H 0 V 40');
		expect(completionPoints(completion(2, 0), 0)).toEqual([]);
		expect(steppedPath([])).toBe('');
	});

	it('filters invalid observations but preserves chronological order and original data', () => {
		const book = { ...completion(1, 8), progress: [
			{ days: 2, percentage: 0.6, recorded_on: '2026-05-03' },
			{ days: -1, percentage: 0.2, recorded_on: '2026-05-01' },
			{ days: 1, percentage: NaN, recorded_on: '2026-05-02' },
			{ days: Infinity, percentage: 0.2, recorded_on: '2026-05-02' },
			{ days: 1, percentage: 1.1, recorded_on: '2026-05-02' },
			{ days: 1, percentage: -0.1, recorded_on: '2026-05-02' },
			{ days: 0, percentage: 0.3, recorded_on: '2026-05-01' }
		] };
		expect(recordedProgress(book)).toEqual([book.progress[6], book.progress[0]]);
		expect(book.progress[0].days).toBe(2);
	});
});
