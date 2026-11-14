import { describe, expect, it } from 'vitest';
import type { ReadingCompletion } from './reading-types.js';
import { completionPoints, completionSummary, orderedCompletions, steppedPath } from './reading-completion.js';

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
		expect(steppedPath(completionPoints(valid))).toBe('');
	});

	it('draws horizontal then vertical steps in completion order', () => {
		const points = completionPoints([completion(1, 2), completion(2, 0), completion(3, 4)], 100, 80);
		expect(points).toEqual([{ x: 0, y: 40 }, { x: 50, y: 80 }, { x: 100, y: 0 }]);
		expect(steppedPath(points)).toBe('M 0 40 H 50 V 80 H 100 V 0');
	});

	it('keeps all-zero durations visible at the baseline, including a single book', () => {
		expect(completionPoints([completion(1, 0)], 100, 80)).toEqual([{ x: 50, y: 80 }]);
		expect(steppedPath(completionPoints([completion(1, 0), completion(2, 0)], 100, 80)))
			.toBe('M 0 80 H 100 V 80');
	});
});
