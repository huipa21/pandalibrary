import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import { backupDownloadPath, createBackup, listBackups, restoreBackup } from './backup.js';

afterEach(() => vi.restoreAllMocks());

it('creates, lists, and stages server backups with explicit restore confirmation', async () => {
	const backup = { name: 'pandalibrary-test.tar.gz', size_bytes: 1024, created_at: '2026-11-12T00:00:00Z' };
	const request = vi.spyOn(api, 'request').mockResolvedValue({ backup });
	await expect(createBackup()).resolves.toEqual(backup);
	expect(request).toHaveBeenLastCalledWith('/admin/backups', { method: 'POST', body: {} });
	request.mockResolvedValue({ backups: [backup], restore_pending: false });
	await expect(listBackups()).resolves.toEqual({ backups: [backup], restore_pending: false });
	request.mockResolvedValue({ status: 'staged', restore_pending: true, restart_required: true });
	await restoreBackup(backup.name);
	expect(request).toHaveBeenLastCalledWith('/admin/backups/restore', {
		method: 'POST', body: { name: backup.name, confirm: true }
	});
	expect(backupDownloadPath('name with space.tar.gz')).toBe('/api/v1/admin/backups/name%20with%20space.tar.gz');
});

it('uploads archives as multipart and surfaces rejected restores', async () => {
	const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
		JSON.stringify({ status: 'staged', restore_pending: true, restart_required: true }), { status: 202 }
	));
	const file = new File(['backup'], 'saved.tar.gz');
	await restoreBackup(file);
	const [path, options] = fetcher.mock.calls[0];
	expect(path).toBe('/api/v1/admin/backups/restore');
	expect(options?.method).toBe('POST');
	expect(options?.headers).toBeUndefined();
	const form = options?.body as FormData;
	expect([...form.keys()]).toEqual(['confirm', 'file']);
	expect(form.get('confirm')).toBe('true');
	expect((form.get('file') as File).name).toBe(file.name);
	fetcher.mockResolvedValue(new Response(JSON.stringify({ status: 400, detail: 'Invalid archive' }), {
		status: 400, headers: { 'content-type': 'application/problem+json' }
	}));
	await expect(restoreBackup(file)).rejects.toBeInstanceOf(ApiError);
	fetcher.mockResolvedValue(new Response('{}', { status: 200 }));
	await expect(restoreBackup(file)).rejects.toThrow('did not confirm');
});
