import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { api, ApiError } from '#lib/api/client.js';
import BuildVersionView from './BuildVersionView.svelte';
import { fetchVersion, versionErrorState, type BuildInfo, type VersionState } from './version.js';

const info: BuildInfo = {
	version: '20251231-150045+0123456789ab-dirty',
	commit: '0123456789abcdef0123456789abcdef01234567',
	commit_date: '2025-12-31T15:00:45Z',
	dirty: true,
	release: 'v1.2.3'
};

afterEach(() => vi.restoreAllMocks());

describe('public build version', () => {
	it('requests the backend metadata without credentials or caching', async () => {
		const request = vi.spyOn(api, 'request').mockResolvedValue(info);
		const signal = new AbortController().signal;
		await expect(fetchVersion(signal)).resolves.toEqual(info);
		expect(request).toHaveBeenCalledWith('/version', { signal, cache: 'no-store', credentials: 'omit' });
	});

	it('rejects malformed or incomplete version responses', async () => {
		const request = vi.spyOn(api, 'request');
		for (const value of [
			null, [], {}, { ...info, commit: '' }, { ...info, commit_date: 123 },
			{ ...info, dirty: 'false' }, { ...info, release: '' }, { ...info, release: undefined }
		]) {
			request.mockResolvedValueOnce(value);
			await expect(fetchVersion()).rejects.toThrow('Invalid build version response');
		}
	});

	it('distinguishes connection/offline errors from HTTP and invalid responses', () => {
		expect(versionErrorState(new TypeError('network'), true)).toBe('offline');
		expect(versionErrorState(new Error('offline'), false)).toBe('offline');
		expect(versionErrorState(new Error('invalid response'), true)).toBe('error');
		expect(versionErrorState(new ApiError(503, '', ''), true)).toBe('error');
	});

	it('renders a short date and commit hash without an expandable details drawer', () => {
		const state: VersionState = { status: 'ready', info };
		const { body } = render(BuildVersionView, { props: { state, onretry: () => {} } });
		expect(body).toContain('Build version');
		expect(body).toContain('Version 251231-0123456');
		expect(body).not.toContain('<details');
		expect(body).not.toContain(info.commit);
	});

	it('renders loading, offline, and failure states with retry', () => {
		const body = (state: VersionState) => render(BuildVersionView, { props: { state, onretry: () => {} } }).body;
		expect(body({ status: 'loading' })).toContain('Loading version');
		expect(body({ status: 'offline' })).toContain('offline');
		expect(body({ status: 'offline' })).toContain('Retry');
		expect(body({ status: 'error' })).toContain('Could not load build version');
		expect(body({ status: 'error' })).toContain('Retry');
	});

	it('provides matching nonempty English and Chinese messages', () => {
		const keys = (messages: Record<string, string>) => Object.keys(messages).filter((key) => key.startsWith('ux9.')).sort();
		expect(keys(en).length).toBeGreaterThan(8);
		expect(keys(zh)).toEqual(keys(en));
		for (const key of keys(en)) {
			const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
			expect((zh as Record<string, string>)[key]).not.toBe('');
			expect(placeholders((zh as Record<string, string>)[key])).toEqual(placeholders((en as Record<string, string>)[key]));
		}
	});
});
