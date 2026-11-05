import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import {
	adminErrorKey,
	buildProviderPatch,
	libraryFieldErrorKey,
	libraryPatch,
	parsePositiveID,
	providerDraft,
	providerFieldErrorKey,
	suggestSlug,
	userPatch,
	validateUserDraft,
	validBaseURL,
	validateLibraryDraft,
	type AdminAction
} from './form.js';
import type { Library, ProviderSettings, User } from './types.js';

const problem = (status: number) => new ApiError(status, '', '{}', { status });
const has = (messages: Record<string, string>, key: string) => Object.hasOwn(messages, key);

const library = { id: 3, name: 'Fiction', slug: 'fiction' } as Library;

const provider = (overrides: Partial<ProviderSettings> = {}): ProviderSettings => ({
	provider: 'neodb',
	enabled: true,
	priority: 20,
	base_url: null,
	has_token: true,
	updated_at: '2026-11-03T00:00:00Z',
	...overrides
});

describe('IDs and library drafts', () => {
	it('accepts only positive safe integer IDs', () => {
		expect(parsePositiveID(' 42 ')).toBe(42);
		for (const value of ['', '0', '-1', '1.5', '1e3', 'abc', '99999999999999999']) expect(parsePositiveID(value)).toBeNull();
	});

	it('mirrors the server name and slug rules', () => {
		expect(validateLibraryDraft({ name: ' Fiction ', slug: 'fiction-2' })).toEqual({ ok: true, name: 'Fiction', slug: 'fiction-2' });
		expect(validateLibraryDraft({ name: ' ', slug: 'a' })).toMatchObject({ field: 'name', error: 'name_required' });
		expect(validateLibraryDraft({ name: 'a\u0007', slug: 'a' })).toMatchObject({ error: 'name_invalid' });
		expect(validateLibraryDraft({ name: 'x'.repeat(1025), slug: 'a' })).toMatchObject({ error: 'name_too_long' });
		expect(validateLibraryDraft({ name: 'A', slug: '-a' })).toMatchObject({ field: 'slug', error: 'slug_invalid' });
		expect(validateLibraryDraft({ name: 'A', slug: 'Fiction' })).toMatchObject({ error: 'slug_invalid' });
		expect(validateLibraryDraft({ name: 'A', slug: 'a'.repeat(129) })).toMatchObject({ error: 'slug_too_long' });
		expect(suggestSlug('Science Fiction & Fantasy!')).toBe('science-fiction-fantasy');
	});

	it('patches only changed library fields', () => {
		expect(libraryPatch(library, { name: 'Fiction', slug: 'novels' })).toEqual({ ok: true, patch: { slug: 'novels' } });
		expect(libraryPatch(library, { name: ' Fiction ', slug: 'fiction' })).toMatchObject({ ok: false, error: 'no_changes' });
	});
});

describe('provider patches', () => {
	it('preserves a stored token by omitting it', () => {
		const result = buildProviderPatch(provider(), { ...providerDraft(provider()), priority: '5' });
		expect(result).toEqual({ ok: true, patch: { priority: 5 }, disablesCredentialProvider: false, removesToken: false });
	});

	describe('account drafts', () => {
		const user: User = {
			id: 7, username: 'reader', display_name: 'Reader', role: 'user', locale: 'en',
			disabled: false, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z'
		};
		const draft = { username: 'reader', displayName: 'Reader', password: 'twelve bytes!', role: 'user', locale: 'en' };

		it('validates UTF-8 byte lengths using the server password limits', () => {
			expect(validateUserDraft({ ...draft, password: '12345678901' }, true)).toMatchObject({ error: 'password_too_short' });
			expect(validateUserDraft({ ...draft, password: '书'.repeat(4) }, true).ok).toBe(true);
			expect(validateUserDraft({ ...draft, password: 'x'.repeat(1025) }, true)).toMatchObject({ error: 'password_too_long' });
			expect(validateUserDraft({ ...draft, password: 'x'.repeat(1024) }, true).ok).toBe(true);
		});

		it('only sends changed account fields and can clear a display name', () => {
			expect(userPatch(user, { ...draft, password: '', displayName: '' })).toEqual({ ok: true, patch: { display_name: '' } });
			expect(userPatch(user, { ...draft, password: '' })).toMatchObject({ ok: false, error: 'no_changes' });
		});
	});

	it('removes a token with explicit null and requires disabling a credentialed provider', () => {
		const draft = { ...providerDraft(provider()), tokenMode: 'remove' as const };
		expect(buildProviderPatch(provider(), draft)).toMatchObject({ ok: false, field: 'enabled', error: 'enable_requires_token' });
		const result = buildProviderPatch(provider(), { ...draft, enabled: false });
		expect(result).toEqual({
			ok: true,
			patch: { api_token: null, enabled: false },
			disablesCredentialProvider: true,
			removesToken: true
		});
	});

	it('validates replacement tokens and providers without tokens', () => {
		const settings = provider({ provider: 'hardcover', enabled: false, has_token: false });
		const draft = { ...providerDraft(settings), enabled: true, tokenMode: 'replace' as const };
		expect(buildProviderPatch(settings, { ...draft, token: '  ' })).toMatchObject({ error: 'token_required' });
		expect(buildProviderPatch(settings, { ...draft, token: 'a\tb' })).toMatchObject({ error: 'token_invalid' });
		expect(buildProviderPatch(settings, { ...draft, token: ' secret ' })).toMatchObject({
			ok: true,
			patch: { api_token: 'secret', enabled: true }
		});
		const openlibrary = provider({ provider: 'openlibrary', has_token: false });
		expect(buildProviderPatch(openlibrary, { ...providerDraft(openlibrary), tokenMode: 'replace', token: 'x' })).toMatchObject({
			error: 'token_unsupported'
		});
	});

	it('checks priority and base URLs and restores the default base URL with null', () => {
		const settings = provider({ base_url: 'https://neodb.example' });
		const draft = providerDraft(settings);
		expect(buildProviderPatch(settings, { ...draft, priority: '10001' })).toMatchObject({ error: 'priority_invalid' });
		expect(buildProviderPatch(settings, { ...draft, priority: '1.5' })).toMatchObject({ error: 'priority_invalid' });
		expect(buildProviderPatch(settings, { ...draft, baseURL: 'https://neodb.example/api' })).toMatchObject({ error: 'base_url_invalid' });
		expect(buildProviderPatch(settings, { ...draft, baseURL: '' })).toMatchObject({ ok: true, patch: { base_url: null } });
		expect(buildProviderPatch(settings, draft)).toMatchObject({ ok: false, error: 'no_changes' });
		expect(validBaseURL('http://localhost:8080')).toBe(true);
		for (const value of ['ftp://x', 'https://u:p@x', 'https://x?q', 'https://x#f', 'not a url']) expect(validBaseURL(value)).toBe(false);
	});
});

describe('admin error keys', () => {
	it('maps conflicts and failures by action without echoing server text', () => {
		expect(adminErrorKey(new TypeError('offline'), 'load')).toBe('admin.error.connection');
		expect(adminErrorKey(problem(401), 'grant')).toBe('admin.error.session');
		expect(adminErrorKey(problem(409), 'save_library')).toBe('admin.error.library_conflict');
		expect(adminErrorKey(problem(409), 'delete_library')).toBe('admin.error.library_delete_conflict');
		expect(adminErrorKey(problem(409), 'run_job')).toBe('admin.error.job_running');
		expect(adminErrorKey(problem(404), 'run_job')).toBe('admin.error.job_unsupported');
		expect(adminErrorKey(problem(503), 'run_job')).toBe('admin.error.maintenance_stopped');
		expect(adminErrorKey(problem(413), 'upload')).toBe('admin.error.upload_too_large');
		expect(adminErrorKey(problem(503), 'upload')).toBe('admin.error.importer_stopped');
		expect(adminErrorKey(problem(400), 'grant')).toBe('admin.error.grant_invalid');
		expect(adminErrorKey(problem(502), 'save_provider')).toBe('admin.error.provider_failed');
	});

	it('only produces keys that exist in both locales', () => {
		const actions: AdminAction[] = [
			'load',
			'more',
			'save_library',
			'delete_library',
			'load_access',
			'grant',
			'revoke',
			'load_hidden',
			'hide',
			'unhide',
			'upload',
			'load_libraries',
			'save_provider',
			'run_job'
		];
		const keys = new Set<string>();
		for (const action of actions) {
			keys.add(adminErrorKey(new TypeError('x'), action));
			for (const status of [400, 401, 403, 404, 409, 413, 422, 500, 502, 503]) keys.add(adminErrorKey(problem(status), action));
		}
		for (const error of ['name_required', 'name_too_long', 'name_invalid', 'slug_required', 'slug_too_long', 'slug_invalid', 'no_changes'] as const) {
			keys.add(libraryFieldErrorKey(error));
		}
		for (const error of [
			'priority_invalid',
			'base_url_invalid',
			'token_required',
			'token_invalid',
			'token_unsupported',
			'enable_requires_token',
			'no_changes'
		] as const) {
			keys.add(providerFieldErrorKey(error));
		}
		for (const error of [
			'username_required',
			'username_too_long',
			'username_invalid',
			'display_name_too_long',
			'password_required',
			'password_too_short',
			'password_too_long',
			'role_invalid',
			'locale_invalid',
			'no_changes'
		] as const) {
			// User field errors map to admin.users.form.error.{error}
			keys.add(`admin.users.form.error.${error}`);
		}
		for (const key of keys) {
			expect(has(en, key), key).toBe(true);
			expect(has(zh, key), key).toBe(true);
		}
	});

	it('keeps the English and Chinese admin messages in sync', () => {
		const adminKeys = (messages: Record<string, string>) => Object.keys(messages).filter((key) => key.startsWith('admin.')).sort();
		expect(adminKeys(zh)).toEqual(adminKeys(en));
	});
});
