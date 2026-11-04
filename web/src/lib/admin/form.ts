import { ApiError } from '#lib/api/client.js';
import type { Library, LibraryPatch, ProviderPatch, ProviderSettings } from './types.js';

const encoder = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const MAX_LIBRARY_NAME_BYTES = 1024;
export const MAX_LIBRARY_SLUG_LENGTH = 128;
export const MAX_PROVIDER_PRIORITY = 10000;
export const MAX_PROVIDER_TOKEN_BYTES = 8192;

/** Returns a positive safe integer ID, or null for anything else. */
export function parsePositiveID(value: string): number | null {
	const text = value.trim();
	if (!/^\d{1,16}$/.test(text)) return null;
	const id = Number(text);
	return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export type LibraryFieldError =
	| 'name_required'
	| 'name_too_long'
	| 'name_invalid'
	| 'slug_required'
	| 'slug_too_long'
	| 'slug_invalid'
	| 'no_changes';

export type LibraryDraftResult =
	| { readonly ok: true; readonly name: string; readonly slug: string }
	| { readonly ok: false; readonly field: 'name' | 'slug' | 'form'; readonly error: LibraryFieldError };

/** Mirrors C1's library name and slug rules so obvious mistakes are reported before submitting. */
export function validateLibraryDraft(draft: { readonly name: string; readonly slug: string }): LibraryDraftResult {
	const name = draft.name.trim();
	if (!name) return { ok: false, field: 'name', error: 'name_required' };
	if (encoder.encode(name).length > MAX_LIBRARY_NAME_BYTES) return { ok: false, field: 'name', error: 'name_too_long' };
	if (CONTROL_CHARACTERS.test(name)) return { ok: false, field: 'name', error: 'name_invalid' };
	const slug = draft.slug.trim();
	if (!slug) return { ok: false, field: 'slug', error: 'slug_required' };
	if (slug.length > MAX_LIBRARY_SLUG_LENGTH) return { ok: false, field: 'slug', error: 'slug_too_long' };
	if (!SLUG.test(slug)) return { ok: false, field: 'slug', error: 'slug_invalid' };
	return { ok: true, name, slug };
}

/** Builds a PATCH containing only changed fields. */
export function libraryPatch(library: Library, draft: { readonly name: string; readonly slug: string }):
	| { readonly ok: true; readonly patch: LibraryPatch }
	| { readonly ok: false; readonly field: 'name' | 'slug' | 'form'; readonly error: LibraryFieldError } {
	const result = validateLibraryDraft(draft);
	if (!result.ok) return result;
	const patch: { name?: string; slug?: string } = {};
	if (result.name !== library.name) patch.name = result.name;
	if (result.slug !== library.slug) patch.slug = result.slug;
	if (patch.name === undefined && patch.slug === undefined) return { ok: false, field: 'form', error: 'no_changes' };
	return { ok: true, patch };
}

/** Suggests a slug from a name; administrators can still edit it. */
export function suggestSlug(name: string): string {
	return name
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_LIBRARY_SLUG_LENGTH)
		.replace(/-+$/, '');
}

export type TokenPolicy = 'none' | 'optional' | 'required';

export interface ProviderCapabilities {
	readonly token: TokenPolicy;
	readonly baseURL: boolean;
	readonly defaultBaseURL: string | null;
}

const PROVIDERS: Record<string, ProviderCapabilities> = {
	openlibrary: { token: 'none', baseURL: false, defaultBaseURL: null },
	googlebooks: { token: 'optional', baseURL: false, defaultBaseURL: null },
	neodb: { token: 'required', baseURL: true, defaultBaseURL: 'https://neodb.social' },
	hardcover: { token: 'required', baseURL: false, defaultBaseURL: null }
};

/** Documents M1's per-provider rules. Unknown providers get the most permissive token choice; the server decides. */
export function providerCapabilities(provider: string): ProviderCapabilities {
	return PROVIDERS[provider] ?? { token: 'optional', baseURL: false, defaultBaseURL: null };
}

export type TokenMode = 'keep' | 'replace' | 'remove';

export interface ProviderDraft {
	enabled: boolean;
	priority: string;
	baseURL: string;
	tokenMode: TokenMode;
	token: string;
}

export function providerDraft(settings: ProviderSettings): ProviderDraft {
	return {
		enabled: settings.enabled,
		priority: String(settings.priority),
		baseURL: settings.base_url ?? '',
		tokenMode: 'keep',
		token: ''
	};
}

export type ProviderFieldError =
	| 'priority_invalid'
	| 'base_url_invalid'
	| 'token_required'
	| 'token_invalid'
	| 'token_unsupported'
	| 'enable_requires_token'
	| 'no_changes';

export interface ProviderChange {
	readonly patch: ProviderPatch;
	/** True when the patch disables a provider that needs a credential to run. */
	readonly disablesCredentialProvider: boolean;
	/** True when the patch deliberately removes a stored token. */
	readonly removesToken: boolean;
}

export type ProviderPatchResult =
	| ({ readonly ok: true } & ProviderChange)
	| { readonly ok: false; readonly field: 'priority' | 'base_url' | 'token' | 'enabled' | 'form'; readonly error: ProviderFieldError };

/** Accepts an HTTP(S) origin without credentials, path, query, or fragment, as M1 requires. */
export function validBaseURL(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	if (url.username || url.password || url.search || url.hash) return false;
	if (url.pathname !== '/' && url.pathname !== '') return false;
	return !/[?#]/.test(value) && !/^[a-z]+:\/\/[^/]+\/./i.test(value);
}

/**
 * Builds a minimal provider PATCH. An omitted token is preserved, explicit null removes
 * it, and an empty base URL restores the provider default.
 */
export function buildProviderPatch(settings: ProviderSettings, draft: ProviderDraft): ProviderPatchResult {
	const capabilities = providerCapabilities(settings.provider);
	const patch: ProviderPatch = {};

	const priorityText = String(draft.priority).trim();
	if (!/^\d{1,5}$/.test(priorityText) || Number(priorityText) > MAX_PROVIDER_PRIORITY) {
		return { ok: false, field: 'priority', error: 'priority_invalid' };
	}
	const priority = Number(priorityText);
	if (priority !== settings.priority) patch.priority = priority;

	if (capabilities.baseURL) {
		const baseURL = draft.baseURL.trim();
		if (baseURL === '') {
			if (settings.base_url !== null) patch.base_url = null;
		} else if (!validBaseURL(baseURL)) {
			return { ok: false, field: 'base_url', error: 'base_url_invalid' };
		} else if (baseURL !== settings.base_url) {
			patch.base_url = baseURL;
		}
	}

	let hasToken = settings.has_token;
	if (draft.tokenMode === 'replace') {
		if (capabilities.token === 'none') return { ok: false, field: 'token', error: 'token_unsupported' };
		const token = draft.token.trim();
		if (!token) return { ok: false, field: 'token', error: 'token_required' };
		if (encoder.encode(token).length > MAX_PROVIDER_TOKEN_BYTES || /[\r\n\t\u0000]/.test(token)) {
			return { ok: false, field: 'token', error: 'token_invalid' };
		}
		patch.api_token = token;
		hasToken = true;
	} else if (draft.tokenMode === 'remove' && settings.has_token) {
		patch.api_token = null;
		hasToken = false;
	}

	if (draft.enabled !== settings.enabled) patch.enabled = draft.enabled;
	if (draft.enabled && capabilities.token === 'required' && !hasToken) {
		return { ok: false, field: 'enabled', error: 'enable_requires_token' };
	}

	if (Object.keys(patch).length === 0) return { ok: false, field: 'form', error: 'no_changes' };
	return {
		ok: true,
		patch,
		disablesCredentialProvider: patch.enabled === false && capabilities.token === 'required',
		removesToken: patch.api_token === null
	};
}

export type AdminAction =
	| 'load'
	| 'more'
	| 'save_library'
	| 'delete_library'
	| 'load_access'
	| 'grant'
	| 'revoke'
	| 'load_hidden'
	| 'hide'
	| 'unhide'
	| 'upload'
	| 'load_libraries'
	| 'save_provider'
	| 'run_job';

/** Maps a failed administrator request to a localized message key without echoing server text. */
export function adminErrorKey(error: unknown, action: AdminAction): string {
	if (!(error instanceof ApiError)) return 'admin.error.connection';
	switch (error.status) {
		case 401:
			return 'admin.error.session';
		case 403:
			return 'admin.error.forbidden';
		case 404:
			switch (action) {
				case 'save_library':
				case 'delete_library':
				case 'load_access':
					return 'admin.error.library_missing';
				case 'grant':
				case 'revoke':
					return 'admin.error.grant_not_found';
				case 'load_hidden':
					return 'admin.error.user_not_found';
				case 'hide':
				case 'unhide':
					return 'admin.error.hide_not_found';
				case 'upload':
					return 'admin.error.upload_library_missing';
				case 'save_provider':
					return 'admin.error.provider_unknown';
				case 'run_job':
					return 'admin.error.job_unsupported';
				default:
					return 'admin.error.not_found';
			}
		case 409:
			if (action === 'save_library') return 'admin.error.library_conflict';
			if (action === 'delete_library') return 'admin.error.library_delete_conflict';
			if (action === 'run_job') return 'admin.error.job_running';
			return 'admin.error.conflict';
		case 400:
		case 422:
			switch (action) {
				case 'more':
					return 'admin.error.stale_cursor';
				case 'save_library':
					return 'admin.error.library_invalid';
				case 'grant':
					return 'admin.error.grant_invalid';
				case 'upload':
					return 'admin.error.upload_invalid';
				case 'save_provider':
					return 'admin.error.provider_invalid';
				default:
					return 'admin.error.invalid';
			}
		case 413:
			return action === 'upload' ? 'admin.error.upload_too_large' : 'admin.error.invalid';
		case 502:
			return action === 'save_provider' ? 'admin.error.provider_failed' : 'admin.error.api';
		case 503:
			if (action === 'upload') return 'admin.error.importer_stopped';
			if (action === 'run_job') return 'admin.error.maintenance_stopped';
			return 'admin.error.unavailable';
		default:
			return 'admin.error.api';
	}
}

export function libraryFieldErrorKey(error: LibraryFieldError): string {
	return `admin.libraries.error.${error}`;
}

export function providerFieldErrorKey(error: ProviderFieldError): string {
	return `admin.providers.error.${error}`;
}
