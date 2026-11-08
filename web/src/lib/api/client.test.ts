import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('API client', () => {
	it('accepts a 204 response without attempting to parse JSON', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
		await expect(createApiClient({ fetcher }).request<void>('/books/1/reviews/me', {
			method: 'DELETE'
		})).resolves.toBeUndefined();
	});

	it('exposes RFC problem details and the HTTP status', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					type: 'about:blank',
					title: 'Unauthorized',
					status: 401,
					detail: 'Sign in to continue'
				}),
				{ status: 401, headers: { 'content-type': 'application/problem+json' } }
			)
		);
		const client = createApiClient({ fetcher });

		await expect(client.request('/books')).rejects.toMatchObject({
			name: 'ApiError',
			status: 401,
			message: 'Sign in to continue',
			problem: { title: 'Unauthorized', detail: 'Sign in to continue' }
		});
	});

	it('reports non-problem HTTP failures without treating them as success', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response('maintenance', { status: 503, statusText: 'Service Unavailable' })
		);
		const client = createApiClient({ fetcher });

		await expect(client.request('/health')).rejects.toMatchObject({
			name: 'ApiError',
			status: 503,
			responseBody: 'maintenance'
		});
	});

	it('joins a configurable base path and serializes typed request bodies', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({ id: 7 })
		);
		const client = createApiClient({ basePath: '/custom/', fetcher });
		const result = await client.request<{ id: number }, { title: string }>('/books', {
			method: 'POST',
			body: { title: 'Three Body Problem' }
		});

		expect(result).toEqual({ id: 7 });
		expect(fetcher).toHaveBeenCalledWith(
			'/custom/books',
			expect.objectContaining({
				method: 'POST',
				body: '{"title":"Three Body Problem"}',
				headers: expect.any(Headers)
			})
		);
	});

	it('marks malformed problem documents as API errors', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response('{', { status: 400, headers: { 'content-type': 'application/problem+json' } })
		);
		const client = createApiClient({ fetcher });
		const request = client.request('/books');

		await expect(request).rejects.toBeInstanceOf(ApiError);
		await expect(request).rejects.toMatchObject({
			status: 400,
			message: 'HTTP 400: invalid application/problem+json response'
		});
	});
});
