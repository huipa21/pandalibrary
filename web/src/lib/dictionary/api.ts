import { api, ApiError } from '#lib/api/client.js';
import { requestErrorKind } from '#lib/paging/errors.js';
import type { DictionaryLanguage, DictionaryResult, DictionaryStatus } from './types.js';

export const DICTIONARY_LANGUAGES: readonly DictionaryLanguage[] = ['en', 'zh', 'ja'];
export const MAX_QUERY_CODE_POINTS = 64;
export const TARGETS_STORAGE_KEY = 'pl.dictionary.targets';

const DEFAULT_TARGETS: Record<DictionaryLanguage, DictionaryLanguage[]> = {
	en: ['zh'],
	zh: ['en'],
	ja: ['zh', 'en']
};

export function isDictionaryLanguage(value: unknown): value is DictionaryLanguage {
	return typeof value === 'string' && (DICTIONARY_LANGUAGES as readonly string[]).includes(value);
}

let statusCache: Promise<DictionaryStatus> | null = null;

/** Loads the installed directions once per session; failures are not cached so a retry can succeed. */
export function fetchDictionaryStatus(): Promise<DictionaryStatus> {
	statusCache ??= api.request<DictionaryStatus>('/dictionary/status').then(
		(status) => ({ directions: status?.directions ?? [], sources: status?.sources ?? [] }),
		(error) => {
			statusCache = null;
			throw error;
		}
	);
	return statusCache;
}

export function resetDictionaryStatusCache() {
	statusCache = null;
}

export function buildLookupPath(q: string, from: DictionaryLanguage, to: DictionaryLanguage, limit?: number): string {
	const params = new URLSearchParams({ q, from, to });
	if (limit !== undefined) params.set('limit', String(Math.max(1, Math.min(50, Math.trunc(limit)))));
	return `/dictionary/lookup?${params.toString()}`;
}

export async function lookupWord(
	q: string,
	from: DictionaryLanguage,
	to: DictionaryLanguage,
	options: { signal?: AbortSignal; limit?: number } = {}
): Promise<DictionaryResult> {
	const result = await api.request<DictionaryResult>(buildLookupPath(q, from, to, options.limit), { signal: options.signal });
	return { ...result, entries: result?.entries ?? [] };
}

/** Trims, collapses whitespace, and caps the selection to the server's query length in code points. */
export function trimSelection(text: string): string {
	const collapsed = text.replace(/\s+/gu, ' ').trim();
	const points = Array.from(collapsed);
	return points.length <= MAX_QUERY_CODE_POINTS ? collapsed : points.slice(0, MAX_QUERY_CODE_POINTS).join('').trim();
}

/** Guesses the selection's language: kana → ja, Han → zh (ja for Japanese books), Latin → en. */
export function detectLanguage(text: string, bookLanguage?: string | null): DictionaryLanguage | null {
	if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
	if (/\p{Script=Han}/u.test(text)) return bookLanguage?.toLowerCase().startsWith('ja') ? 'ja' : 'zh';
	if (/\p{Script=Latin}/u.test(text)) return 'en';
	return null;
}

export function availableSources(status: DictionaryStatus | null | undefined): DictionaryLanguage[] {
	const froms = new Set(status?.directions.map((direction) => direction.from));
	return DICTIONARY_LANGUAGES.filter((lang) => froms.has(lang));
}

export function availableTargets(status: DictionaryStatus | null | undefined, from: DictionaryLanguage): DictionaryLanguage[] {
	const targets = new Set(status?.directions.filter((direction) => direction.from === from).map((direction) => direction.to));
	return DICTIONARY_LANGUAGES.filter((lang) => targets.has(lang));
}

/** Prefers the remembered target, then the language default, then the first installed target. */
export function pickTarget(
	status: DictionaryStatus | null | undefined,
	from: DictionaryLanguage,
	remembered?: DictionaryLanguage | null
): DictionaryLanguage | null {
	const targets = availableTargets(status, from);
	for (const candidate of [remembered, ...DEFAULT_TARGETS[from]]) {
		if (candidate && targets.includes(candidate)) return candidate;
	}
	return targets[0] ?? null;
}

function readTargets(storage: Storage | undefined): Partial<Record<DictionaryLanguage, DictionaryLanguage>> {
	try {
		const parsed: unknown = JSON.parse(storage?.getItem(TARGETS_STORAGE_KEY) ?? '{}');
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		const targets: Partial<Record<DictionaryLanguage, DictionaryLanguage>> = {};
		for (const [from, to] of Object.entries(parsed)) {
			if (isDictionaryLanguage(from) && isDictionaryLanguage(to)) targets[from] = to;
		}
		return targets;
	} catch {
		return {};
	}
}

function browserStorage(): Storage | undefined {
	try {
		return typeof localStorage === 'undefined' ? undefined : localStorage;
	} catch {
		return undefined;
	}
}

export function rememberedTarget(from: DictionaryLanguage, storage = browserStorage()): DictionaryLanguage | null {
	return readTargets(storage)[from] ?? null;
}

export function rememberTarget(from: DictionaryLanguage, to: DictionaryLanguage, storage = browserStorage()) {
	if (!storage) return;
	try {
		storage.setItem(TARGETS_STORAGE_KEY, JSON.stringify({ ...readTargets(storage), [from]: to }));
	} catch (error) {
		console.error('Could not save the dictionary target language', error);
	}
}

export function dictionaryErrorKey(
	error: unknown
): 'dict.error.invalid' | 'dict.error.connection' | 'dict.error.session' | 'dict.error.unavailable' | 'dict.error.api' {
	if (error instanceof ApiError && error.status === 503) return 'dict.error.unavailable';
	switch (requestErrorKind(error)) {
		case 'invalid':
			return 'dict.error.invalid';
		case 'connection':
			return 'dict.error.connection';
		case 'unauthorized':
			return 'dict.error.session';
		default:
			return 'dict.error.api';
	}
}
