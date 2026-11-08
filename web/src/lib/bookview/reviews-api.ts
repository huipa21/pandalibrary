import { api } from '#lib/api/client.js';

export interface ReviewAuthor {
	readonly id: number;
	readonly display_name: string;
}

export interface Review {
	readonly id: number;
	readonly book_id: number;
	readonly author: ReviewAuthor;
	readonly body: string;
	readonly created_at: string;
	readonly updated_at: string;
	readonly mine: boolean;
}

export interface ReviewPage {
	readonly mine: Review | null;
	readonly items: Review[];
	readonly next_cursor: string | null;
	readonly total: number;
}

function reviewPath(bookId: number): string {
	validateId(bookId);
	return `/books/${bookId}/reviews`;
}

function validateId(id: number): void {
	if (!Number.isSafeInteger(id) || id < 1) throw new RangeError('ID must be a positive safe integer.');
}

export async function listReviews(
	bookId: number,
	options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {}
): Promise<ReviewPage> {
	const path = reviewPath(bookId);
	const limit = options.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
		throw new RangeError('Review page limit must be between 1 and 50.');
	}
	const params = new URLSearchParams({ limit: String(limit) });
	if (options.cursor != null) params.set('cursor', options.cursor);
	return api.request(`${path}?${params}`, options.signal === undefined ? {} : { signal: options.signal });
}

export async function saveMyReview(bookId: number, body: string): Promise<Review> {
	const path = reviewPath(bookId);
	body = body.trim();
	const length = Array.from(body).length;
	if (length < 1 || length > 10000 || body.includes('\0')) {
		throw new RangeError('Review body must contain 1 to 10000 characters and no NUL characters.');
	}
	const result = await api.request<{ review: Review }>(`${path}/me`, { method: 'PUT', body: { body } });
	return result.review;
}

export async function deleteMyReview(bookId: number): Promise<void> {
	await api.request<void>(`${reviewPath(bookId)}/me`, { method: 'DELETE' });
}

export async function deleteReview(bookId: number, reviewId: number): Promise<void> {
	const path = reviewPath(bookId);
	validateId(reviewId);
	await api.request<void>(`${path}/${reviewId}`, { method: 'DELETE' });
}
