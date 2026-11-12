import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '#lib/api/client.js';
import { InvalidTagsError, normalizeTags, saveBookTags } from './tags.js';

afterEach(() => vi.restoreAllMocks());

describe('manual metadata tags', () => {
	it('matches backend whitespace trimming, ASCII deduplication and Unicode byte limits', () => {
		expect(normalizeTags(['\u0085 Fantasy \u3000', 'É', 'é', '\ufeff'])).toEqual(['Fantasy', 'É', 'é', '\ufeff']);
		expect(() => normalizeTags(['Fantasy', ' fantasy '])).toThrow(new InvalidTagsError('duplicate'));
		expect(normalizeTags(['书'.repeat(341)])).toHaveLength(1);
		expect(() => normalizeTags(['书'.repeat(342)])).toThrow(new InvalidTagsError('name'));
		for (const name of ['', ' \t ', 'a\nb', 'a\u0085b', 'a\0b']) {
			expect(() => normalizeTags([name])).toThrow(new InvalidTagsError('name'));
		}
		expect(() => normalizeTags(Array.from({ length: 1001 }, (_, index) => String(index)))).toThrow(new InvalidTagsError('limit'));
	});

	it('patches only tags, supports clearing all, and propagates failures for retry', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ book: { id: 21, tags: [] } });
		await saveBookTags(21, [' Fantasy ']);
		expect(request).toHaveBeenLastCalledWith('/books/21', { method: 'PATCH', body: { tags: ['Fantasy'] } });
		await saveBookTags(21, []);
		expect(request).toHaveBeenLastCalledWith('/books/21', { method: 'PATCH', body: { tags: [] } });
		request.mockRejectedValueOnce(new Error('offline'));
		await expect(saveBookTags(21, ['Retry'])).rejects.toThrow('offline');
		await expect(saveBookTags(21, ['a', 'A'])).rejects.toThrow(InvalidTagsError);
		expect(request).toHaveBeenCalledTimes(3);
	});
});
