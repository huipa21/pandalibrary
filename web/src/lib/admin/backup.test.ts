import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import { backupDownloadPath, createBackup, listBackups, restoreBackup } from './backup.js';

const passphrase = 'correct horse battery staple';
const backup = {
	name: 'full-test.tar.gz.age',
	size_bytes: 1024,
	created_at: '2026-11-12T00:00:00Z',
	encrypted: true
};

afterEach(() => vi.restoreAllMocks());

it('creates, lists, and stages encrypted server backups with a passphrase', async () => {
	const request = vi.spyOn(api, 'request').mockResolvedValue({ backup });
	await expect(createBackup(passphrase)).resolves.toEqual(backup);
	expect(request).toHaveBeenLastCalledWith('/admin/backups', { method: 'POST', body: { passphrase } });
	request.mockResolvedValue({ backups: [backup], restore_pending: false });
	await expect(listBackups()).resolves.toEqual({ backups: [backup], restore_pending: false });
	request.mockResolvedValue({ status: 'staged', restore_pending: true, restart_required: true });
	await restoreBackup(backup.name, passphrase);
	expect(request).toHaveBeenLastCalledWith('/admin/backups/restore', {
		method: 'POST', body: { name: backup.name, confirm: true, passphrase }
	});
	expect(backupDownloadPath('name with space.tar.gz.age')).toBe(
		'/api/v1/admin/backups/name%20with%20space.tar.gz.age'
	);
});

it('uploads encrypted archives as multipart and surfaces rejected restores', async () => {
	const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
		JSON.stringify({ status: 'staged', restore_pending: true, restart_required: true }), { status: 202 }
	));
	const file = new File(['backup'], 'saved.tar.gz.age');
	await restoreBackup(file, passphrase);
	const [path, options] = fetcher.mock.calls[0];
	expect(path).toBe('/api/v1/admin/backups/restore');
	expect(options?.method).toBe('POST');
	expect(options?.headers).toBeUndefined();
	const form = options?.body as FormData;
	expect([...form.keys()]).toEqual(['confirm', 'passphrase', 'file']);
	expect(form.get('confirm')).toBe('true');
	expect(form.get('passphrase')).toBe(passphrase);
	expect((form.get('file') as File).name).toBe(file.name);
	fetcher.mockResolvedValue(new Response(JSON.stringify({ status: 400, detail: 'Invalid archive' }), {
		status: 400, headers: { 'content-type': 'application/problem+json' }
	}));
	await expect(restoreBackup(file, passphrase)).rejects.toBeInstanceOf(ApiError);
	fetcher.mockResolvedValue(new Response('{}', { status: 200 }));
	await expect(restoreBackup(file, passphrase)).rejects.toThrow('did not confirm');
});
