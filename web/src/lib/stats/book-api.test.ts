import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '#lib/api/client.js';
import { addedLabel, bucketData, fetchBookStats, formatBookShare, languageLabel, publicationTimeline, topTwenty } from './book-api.js';

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

	it('keeps unknown years out of the numeric timeline and sorts years numerically', () => {
		const buckets = [{ key: 'unknown', count: 3 }, { key: '2000', count: 2 }, { key: '950', count: 1 }];
		expect(publicationTimeline(buckets).map(({ key }) => key)).toEqual(['950', '2000']);
		expect(buckets[0].key).toBe('unknown');
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
