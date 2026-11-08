import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import { deleteMyReview, deleteReview, listReviews, saveMyReview, type Review } from './reviews-api';

afterEach(() => vi.restoreAllMocks());

describe('reviews API', () => {
	const review: Review = {
		id: 9, book_id: 21, author: { id: 2, display_name: 'Reader' }, body: 'Review',
		created_at: '2026-11-08T00:00:00Z', updated_at: '2026-11-08T00:00:00Z', mine: true
	};

	it('lists with defaults, encoded cursor and cancellation signal', async () => {
		const page = { mine: review, items: [], next_cursor: null, total: 1 };
		const request = vi.spyOn(api, 'request').mockResolvedValue(page);
		await expect(listReviews(21)).resolves.toEqual(page);
		const signal = new AbortController().signal;
		await listReviews(21, { cursor: 'a/b+ c=?', limit: 3, signal });
		expect(request.mock.calls).toEqual([
			['/books/21/reviews?limit=20', {}],
			['/books/21/reviews?limit=3&cursor=a%2Fb%2B+c%3D%3F', { signal }]
		]);
	});

	it('saves trimmed bodies and unwraps the response', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ review });
		await expect(saveMyReview(21, '  Review\n')).resolves.toEqual(review);
		expect(request).toHaveBeenCalledWith('/books/21/reviews/me', {
			method: 'PUT', body: { body: 'Review' }
		});
	});

	it('deletes own and administrator-selected reviews', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue(undefined);
		await expect(deleteMyReview(21)).resolves.toBeUndefined();
		await expect(deleteReview(21, 9)).resolves.toBeUndefined();
		expect(request.mock.calls).toEqual([
			['/books/21/reviews/me', { method: 'DELETE' }],
			['/books/21/reviews/9', { method: 'DELETE' }]
		]);
	});

	it('rejects invalid IDs, limits and bodies before requesting', async () => {
		const request = vi.spyOn(api, 'request');
		for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(listReviews(id)).rejects.toBeInstanceOf(RangeError);
			await expect(saveMyReview(id, 'review')).rejects.toBeInstanceOf(RangeError);
			await expect(deleteMyReview(id)).rejects.toBeInstanceOf(RangeError);
			await expect(deleteReview(21, id)).rejects.toBeInstanceOf(RangeError);
			await expect(deleteReview(id, 9)).rejects.toBeInstanceOf(RangeError);
		}
		for (const limit of [0, 51, 1.5, NaN]) {
			await expect(listReviews(21, { limit })).rejects.toBeInstanceOf(RangeError);
		}
		for (const body of ['', ' \n\t', '界'.repeat(10001), 'x\0y']) {
			await expect(saveMyReview(21, body)).rejects.toBeInstanceOf(RangeError);
		}
		expect(request).not.toHaveBeenCalled();
	});

	it('counts Unicode code points rather than UTF-16 code units', async () => {
		vi.spyOn(api, 'request').mockResolvedValue({ review });
		await expect(saveMyReview(21, '😀'.repeat(10000))).resolves.toEqual(review);
		await expect(saveMyReview(21, '😀'.repeat(10001))).rejects.toBeInstanceOf(RangeError);
	});

	it('propagates API errors unchanged from every operation', async () => {
		const error = new ApiError(403, 'Forbidden', '');
		vi.spyOn(api, 'request').mockRejectedValue(error);
		for (const request of [listReviews(21), saveMyReview(21, 'review'), deleteMyReview(21), deleteReview(21, 9)]) {
			await expect(request).rejects.toBe(error);
		}
	});
});
