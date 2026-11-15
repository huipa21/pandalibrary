import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '#lib/api/client.js';
import { addedLabel, addedTimeline, bucketData, fetchBookStats, formatBookShare, languageLabel, publicationTimeline, topTwenty } from './book-api.js';

afterEach(() => vi.restoreAllMocks());

describe('catalog stats', () => {
	it('requests all-time book stats with only the browser timezone, no cache and a cancellable signal', async () => {
		const response = { total_books: 0 };
		const request = vi.spyOn(api, 'request').mockResolvedValue(response);
		const controller = new AbortController();
		expect(await fetchBookStats('America/New_York', controller.signal)).toBe(response);
		expect(request).toHaveBeenCalledWith('/stats/books?timezone=America%2FNew_York', {
			signal: controller.signal, cache: 'no-store'
		});
	});

	it('bases overlapping distributions on total books, handles empty totals and localizes numbers', () => {
		const data = bucketData([{ key: 'epub', count: 3 }, { key: 'pdf', count: 2 }], (key) => key.toUpperCase(), 'en', 4);
		expect(data[0]).toEqual({ key: 'epub', label: 'EPUB', value: 3, display: '3 (75%)' });
		expect(data[1].display).toBe('2 (50%)');
		expect(formatBookShare(0, 0, 'en')).toBe('0 (0%)');
		expect(formatBookShare(1000, 3000, 'zh')).toBe('1,000 (33.3%)');
		expect(bucketData([{ key: 'month', count: 1200 }], (key) => key, 'en')[0].display).toBe('1,200');
	});

	it('pads recent added months across years without losing older counts or mutating the response', () => {
		const buckets = [{ key: '2024-01', count: 2 }, { key: '2026-01', count: 3 }, { key: '2026-03', count: 1 }];
		const timeline = addedTimeline(buckets);
		expect(timeline.map(({ key }) => key)).toEqual([
			'2024-01', '2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10',
			'2025-11', '2025-12', '2026-01', '2026-02', '2026-03'
		]);
		expect(timeline.filter(({ count }) => count > 0)).toEqual(buckets);
		expect(timeline.find(({ key }) => key === '2026-02')?.count).toBe(0);
		expect(buckets).toEqual([{ key: '2024-01', count: 2 }, { key: '2026-01', count: 3 }, { key: '2026-03', count: 1 }]);
	});

	it('keeps empty and unrecognized added buckets and respects the start of the supported calendar', () => {
		expect(addedTimeline([])).toEqual([]);
		expect(addedTimeline([{ key: 'unknown', count: 1 }])).toEqual([{ key: 'unknown', count: 1 }]);
		expect(addedTimeline([{ key: '0001-02', count: 1 }])).toEqual([
			{ key: '0001-01', count: 0 }, { key: '0001-02', count: 1 }
		]);
	});

	it('keeps unknown years out of the numeric timeline and sorts intervals numerically', () => {
		const buckets = [{ key: 'unknown', count: 3 }, { key: '2000', count: 2 }, { key: '950', count: 1 }];
		expect(publicationTimeline(buckets)).toEqual([
			{ key: '800', count: 1 }, { key: '1000', count: 0 }, { key: '1200', count: 0 },
			{ key: '1400', count: 0 }, { key: '1600', count: 0 }, { key: '1800', count: 0 },
			{ key: '2000', count: 2 }
		]);
		expect(buckets[0].key).toBe('unknown');
	});

	it('fills regular decade intervals even for only two distant publication years', () => {
		const buckets = [{ key: '1946', count: 3 }, { key: '1865', count: 2 }];
		expect(publicationTimeline(buckets)).toEqual([
			{ key: '1860', count: 2 }, { key: '1870', count: 0 }, { key: '1880', count: 0 },
			{ key: '1890', count: 0 }, { key: '1900', count: 0 }, { key: '1910', count: 0 },
			{ key: '1920', count: 0 }, { key: '1930', count: 0 }, { key: '1940', count: 3 }
		]);
		expect(buckets).toEqual([{ key: '1946', count: 3 }, { key: '1865', count: 2 }]);
	});

	it('retains individual years for a single year and adjacent years', () => {
		expect(publicationTimeline([{ key: '2026', count: 4 }])).toEqual([{ key: '2026', count: 4 }]);
		expect(publicationTimeline([{ key: '2026', count: 1 }, { key: '2025', count: 2 }])).toEqual([
			{ key: '2025', count: 2 }, { key: '2026', count: 1 }
		]);
		expect(publicationTimeline([{ key: '2024', count: 1 }, { key: '2026', count: 2 }])).toEqual([
			{ key: '2024', count: 1 }, { key: '2025', count: 0 }, { key: '2026', count: 2 }
		]);
	});

	it('sums years within an interval and adapts to very wide chronological ranges', () => {
		const timeline = publicationTimeline([
			{ key: '1', count: 2 }, { key: '950', count: 3 }, { key: '9999', count: 4 }
		]);
		expect(timeline).toHaveLength(10);
		expect(timeline.map(({ key }) => key)).toEqual(['0', '1000', '2000', '3000', '4000', '5000', '6000', '7000', '8000', '9000']);
		expect(timeline.map(({ count }) => count)).toEqual([5, 0, 0, 0, 0, 0, 0, 0, 0, 4]);
	});

	it('returns no timeline for empty, unknown-only or invalid year data', () => {
		expect(publicationTimeline([])).toEqual([]);
		expect(publicationTimeline([{ key: 'unknown', count: 3 }])).toEqual([]);
		expect(publicationTimeline([{ key: 'NaN', count: 1 }, { key: '99999999999999999999', count: 2 }])).toEqual([]);
	});

	it('localizes dates and language labels with a fallback for invalid language codes', () => {
		expect(addedLabel('2026-03', 'en')).toBe('Mar 2026');
		expect(languageLabel('zh-Hans', 'en')).toBe('Simplified Chinese');
		expect(languageLabel('not_a_language', 'en')).toBe('not_a_language');
	});

	it('orders ranking values without mutating the response and caps oversized rankings', () => {
		const books = Array.from({ length: 25 }, (_, value) => ({ value }));
		const ranked = topTwenty(books, (book) => book.value);
		expect(ranked).toHaveLength(20);
		expect(ranked[0].value).toBe(24);
		expect(ranked[19].value).toBe(5);
		expect(books[0].value).toBe(0);
	});
});
