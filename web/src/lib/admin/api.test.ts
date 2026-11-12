import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import {
	buildAccessPath,
	buildAdminLibrariesPath,
	buildAdminUsersPath,
	buildHiddenBooksPath,
	buildImportsPath,
	createUser,
	createLibrary,
	deleteUser,
	deleteLibrary,
	grantLibraryAccess,
	hideBook,
	listAllAdminLibraries,
	listImports,
	listAdminUsers,
	listMaintenanceJobs,
	listProviders,
	revokeLibraryAccess,
	revokeUserCredentials,
	resetUserPassword,
	runMaintenanceJob,
	unhideBook,
	updateLibrary,
	updateUser,
	updateProvider,
	uploadBook
} from './api.js';
import type { ImportJob, Library } from './types.js';

afterEach(() => vi.restoreAllMocks());

const library = (id: number): Library => ({
	id,
	name: `Library ${id}`,
	slug: `library-${id}`,
	created_at: '2026-11-03T00:00:00Z',
	updated_at: '2026-11-03T00:00:00Z'
}) as Library;

const job: ImportJob = {
	id: 12,
	source: 'upload',
	library_id: 1,
	user_id: 9,
	original_name: 'Book.epub',
	sha256: null,
	status: 'pending',
	error: null,
	book_id: null,
	duplicate_of_book_id: null,
	created_at: '2026-11-03T00:00:00Z',
	finished_at: null
} as ImportJob;

describe('admin paths', () => {
	it('preserves account search category and query across pages', () => {
		const params = new URLSearchParams(buildAdminUsersPath({
			q: '  A&B  ', category: 'display_name', cursor: 'next/+='
		}).split('?')[1]);
		expect(params.get('q')).toBe('A&B');
		expect(params.get('category')).toBe('display_name');
		expect(params.get('cursor')).toBe('next/+=');
		expect(buildAdminUsersPath({ q: ' ', category: 'all' })).toBe('/admin/users?limit=50');
	});
	it('builds paged paths with a bounded limit and verbatim cursor', () => {
		expect(buildAdminLibrariesPath()).toBe('/admin/libraries?limit=50');
		const cursor = 'b3BhcXVl/+==';
		const params = new URLSearchParams(buildAccessPath(3, { cursor, limit: 999 }).split('?')[1]);
		expect(buildAccessPath(3).startsWith('/admin/libraries/3/access?')).toBe(true);
		expect(params.get('cursor')).toBe(cursor);
		expect(params.get('limit')).toBe('100');
		expect(buildHiddenBooksPath(5).startsWith('/admin/users/5/hidden-books?')).toBe(true);
		expect(buildImportsPath({ cursor: '40' })).toBe('/imports?limit=50&cursor=40');
	});
});

describe('library and access requests', () => {
	it('sends the documented methods and bodies', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ library: library(4) });
		await createLibrary('Fiction', 'fiction');
		expect(request).toHaveBeenLastCalledWith('/admin/libraries', { method: 'POST', body: { name: 'Fiction', slug: 'fiction' } });
		await updateLibrary(4, { slug: 'novels' });
		expect(request).toHaveBeenLastCalledWith('/admin/libraries/4', { method: 'PATCH', body: { slug: 'novels' } });
		request.mockResolvedValue({ deleted: true });
		await deleteLibrary(4);
		expect(request).toHaveBeenLastCalledWith('/admin/libraries/4', { method: 'DELETE' });
		request.mockResolvedValue({ granted: true });
		await grantLibraryAccess(4, 7);
		expect(request).toHaveBeenLastCalledWith('/admin/libraries/4/access/7', { method: 'PUT' });
		request.mockResolvedValue({ revoked: true });
		await revokeLibraryAccess(4, 7);
		expect(request).toHaveBeenLastCalledWith('/admin/libraries/4/access/7', { method: 'DELETE' });
		request.mockResolvedValue({ hidden: true });
		await hideBook(7, 30);
		expect(request).toHaveBeenLastCalledWith('/admin/users/7/hidden-books/30', { method: 'PUT' });
		request.mockResolvedValue({ hidden: false });
		await unhideBook(7, 30);
		expect(request).toHaveBeenLastCalledWith('/admin/users/7/hidden-books/30', { method: 'DELETE' });
	});

	describe('account requests', () => {
		it('uses the UX7 endpoints and sends only the documented fields', async () => {
			const request = vi.spyOn(api, 'request').mockResolvedValue({ items: [], next_cursor: null });
			await listAdminUsers({ cursor: 'next', limit: 25 });
			expect(request.mock.calls[0][0]).toBe('/admin/users?limit=25&cursor=next');
			request.mockResolvedValue({ user: { id: 7 } });
			await createUser('reader', 'Reader', 'a long password', 'user', 'zh');
			expect(request).toHaveBeenLastCalledWith('/admin/users', {
				method: 'POST', body: { username: 'reader', display_name: 'Reader', password: 'a long password', role: 'user', locale: 'zh' }
			});
			await updateUser(7, { display_name: '', disabled: false });
			expect(request).toHaveBeenLastCalledWith('/admin/users/7', { method: 'PATCH', body: { display_name: '', disabled: false } });
			request.mockResolvedValue({ reset: true });
			await resetUserPassword(7, 'replacement password');
			expect(request).toHaveBeenLastCalledWith('/admin/users/7/reset-password', { method: 'POST', body: { password: 'replacement password' } });
			request.mockResolvedValue({ revoked: true });
			await revokeUserCredentials(7);
			expect(request).toHaveBeenLastCalledWith('/admin/users/7/revoke-credentials', { method: 'POST', body: {} });
			request.mockResolvedValue({ deleted: true });
			await deleteUser(7);
			expect(request).toHaveBeenLastCalledWith('/admin/users/7', { method: 'DELETE' });
		});
	});

	it('follows library cursors and rejects a repeated cursor', async () => {
		const request = vi
			.spyOn(api, 'request')
			.mockResolvedValueOnce({ items: [library(1)], next_cursor: 'a' })
			.mockResolvedValueOnce({ items: [library(2)], next_cursor: null });
		const all = await listAllAdminLibraries();
		expect(all.map((item) => item.id)).toEqual([1, 2]);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[1][0]).toContain('cursor=a');

		request
			.mockResolvedValueOnce({ items: [library(1)], next_cursor: 'a' })
			.mockResolvedValueOnce({ items: [library(2)], next_cursor: 'a' });
		await expect(listAllAdminLibraries()).rejects.toThrow(/repeated/);
	});

	it('lists imports newest first with the server cursor', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ items: [job], next_cursor: null });
		await listImports({ cursor: '12' });
		expect(request.mock.calls[0][0]).toBe('/imports?limit=50&cursor=12');
	});
});

describe('uploadBook', () => {
	it('posts one file as multipart with the library ID', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ job }), { status: 202, headers: { 'content-type': 'application/json' } })
		);
		const file = new File(['epub'], 'Book.epub', { type: 'application/epub+zip' });
		await expect(uploadBook(1, file, { fetcher })).resolves.toEqual(job);
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe('/api/v1/uploads');
		expect(init?.method).toBe('POST');
		expect(init?.headers).toBeUndefined();
		const form = init?.body as FormData;
		expect([...form.keys()]).toEqual(['library_id', 'file', 'visibility']);
		expect(form.get('library_id')).toBe('1');
		expect(form.get('visibility')).toBe('public');
		expect((form.get('file') as File).name).toBe('Book.epub');
	});

	it('includes the selected private visibility in direct uploads', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ job }), { status: 202 })
		);
		await uploadBook(1, new File(['x'], 'a.epub'), { fetcher, visibility: 'private' });
		expect((fetcher.mock.calls[0][1]?.body as FormData).get('visibility')).toBe('private');
	});

	it('turns problem responses into ApiError', async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ status: 413, detail: 'too large' }), {
				status: 413,
				headers: { 'content-type': 'application/problem+json' }
			})
		);
		const error = await uploadBook(1, new File(['x'], 'a.epub'), { fetcher }).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(413);
		expect((error as ApiError).problem?.detail).toBe('too large');
	});
});

describe('provider and maintenance requests', () => {
	it('omits an unchanged token and sends null to remove one', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue({ provider: {} });
		await updateProvider('neodb', { enabled: false });
		expect(request).toHaveBeenLastCalledWith('/admin/metadata/providers/neodb', { method: 'PATCH', body: { enabled: false } });
		await updateProvider('neodb', { api_token: null, base_url: null });
		expect(request).toHaveBeenLastCalledWith('/admin/metadata/providers/neodb', {
			method: 'PATCH',
			body: { base_url: null, api_token: null }
		});
		await updateProvider('hardcover', { api_token: 'secret' });
		expect(request.mock.lastCall?.[1]).toEqual({ method: 'PATCH', body: { api_token: 'secret' } });
	});

	it('unwraps provider and maintenance envelopes', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValueOnce({ providers: [{ provider: 'neodb' }] });
		await expect(listProviders()).resolves.toEqual([{ provider: 'neodb' }]);
		request.mockResolvedValueOnce({ jobs: [{ name: 'backup' }] });
		await expect(listMaintenanceJobs()).resolves.toEqual([{ name: 'backup' }]);
		request.mockResolvedValueOnce({ run: { id: 'r1', status: 'accepted' } });
		await expect(runMaintenanceJob('fts-check')).resolves.toEqual({ id: 'r1', status: 'accepted' });
		expect(request).toHaveBeenLastCalledWith('/admin/maintenance/fts-check', { method: 'POST' });
	});
});
