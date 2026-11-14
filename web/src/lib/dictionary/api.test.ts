import en from '../../../messages/en.json';
import zh from '../../../messages/zh.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '#lib/api/client.js';
import {
	availableSources,
	availableTargets,
	buildLookupPath,
	detectLanguage,
	dictionaryErrorKey,
	fetchDictionaryStatus,
	lookupWord,
	pickTarget,
	rememberedTarget,
	rememberTarget,
	resetDictionaryStatusCache,
	TARGETS_STORAGE_KEY,
	trimSelection
} from './api.js';
import type { DictionaryLanguage, DictionaryStatus } from './types.js';

afterEach(() => {
	vi.restoreAllMocks();
	resetDictionaryStatusCache();
});

function status(...pairs: [DictionaryLanguage, DictionaryLanguage][]): DictionaryStatus {
	return { directions: pairs.map(([from, to]) => ({ from, to, sources: ['x'] })), sources: [] };
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
	const data = new Map(Object.entries(initial));
	return {
		get length() { return data.size; },
		clear: () => data.clear(),
		getItem: (key) => data.get(key) ?? null,
		key: (index) => [...data.keys()][index] ?? null,
		removeItem: (key) => { data.delete(key); },
		setItem: (key, value) => { data.set(key, String(value)); }
	};
}

describe('dictionary helpers', () => {
	it('detects the selection language from its script and the book language', () => {
		expect(detectLanguage('食べました')).toBe('ja');
		expect(detectLanguage('カメラ')).toBe('ja');
		expect(detectLanguage('running')).toBe('en');
		expect(detectLanguage('café')).toBe('en');
		expect(detectLanguage('学习')).toBe('zh');
		expect(detectLanguage('学习', 'ja-JP')).toBe('ja');
		expect(detectLanguage('学习', 'zh-Hans')).toBe('zh');
		expect(detectLanguage('12 / 34')).toBeNull();
	});

	it('trims, collapses whitespace, and caps selections to 64 code points', () => {
		expect(trimSelection('  hello \n\t world  ')).toBe('hello world');
		expect(Array.from(trimSelection('𠀀'.repeat(70)))).toHaveLength(64);
		expect(trimSelection(`${'a'.repeat(63)} b`)).toBe('a'.repeat(63));
	});

	it('lists only installed directions in a stable order', () => {
		const installed = status(['ja', 'en'], ['en', 'zh'], ['en', 'en'], ['ja', 'zh']);
		expect(availableSources(installed)).toEqual(['en', 'ja']);
		expect(availableTargets(installed, 'en')).toEqual(['en', 'zh']);
		expect(availableTargets(installed, 'zh')).toEqual([]);
		expect(availableTargets(null, 'en')).toEqual([]);
	});

	it('prefers the remembered target, then the language default, then the first installed target', () => {
		const all = status(['en', 'en'], ['en', 'zh'], ['en', 'ja'], ['zh', 'zh'], ['zh', 'en'], ['ja', 'en'], ['ja', 'zh']);
		expect(pickTarget(all, 'en')).toBe('zh');
		expect(pickTarget(all, 'zh')).toBe('en');
		expect(pickTarget(all, 'ja')).toBe('zh');
		expect(pickTarget(status(['ja', 'en'], ['ja', 'ja']), 'ja')).toBe('en');
		expect(pickTarget(status(['ja', 'ja']), 'ja')).toBe('ja');
		expect(pickTarget(all, 'en', 'ja')).toBe('ja');
		expect(pickTarget(status(['en', 'zh']), 'en', 'ja')).toBe('zh');
		expect(pickTarget(status(['en', 'zh']), 'ja')).toBeNull();
	});

	it('remembers the chosen target per source language and ignores corrupt storage', () => {
		const storage = memoryStorage();
		rememberTarget('en', 'ja', storage);
		rememberTarget('zh', 'zh', storage);
		expect(rememberedTarget('en', storage)).toBe('ja');
		expect(rememberedTarget('zh', storage)).toBe('zh');
		expect(rememberedTarget('ja', storage)).toBeNull();
		expect(JSON.parse(storage.getItem(TARGETS_STORAGE_KEY)!)).toEqual({ en: 'ja', zh: 'zh' });
		expect(rememberedTarget('en', memoryStorage({ [TARGETS_STORAGE_KEY]: '{oops' }))).toBeNull();
		expect(rememberedTarget('en', memoryStorage({ [TARGETS_STORAGE_KEY]: '{"en":"fr"}' }))).toBeNull();
	});

	it('builds lookup requests and passes abort signals through the API client', async () => {
		expect(buildLookupPath('a&b c', 'en', 'zh')).toBe('/dictionary/lookup?q=a%26b+c&from=en&to=zh');
		expect(buildLookupPath('x', 'ja', 'en', 500)).toBe('/dictionary/lookup?q=x&from=ja&to=en&limit=50');
		const request = vi.spyOn(api, 'request').mockResolvedValue({ query: '学习', term: '学习', from: 'zh', to: 'en', entries: null });
		const controller = new AbortController();
		const result = await lookupWord('学习', 'zh', 'en', { signal: controller.signal });

		expect(request).toHaveBeenCalledWith('/dictionary/lookup?q=%E5%AD%A6%E4%B9%A0&from=zh&to=en', { signal: controller.signal });
		expect(result.entries).toEqual([]);
	});

	it('caches the dictionary status per session but retries after a failure', async () => {
		const request = vi.spyOn(api, 'request')
			.mockRejectedValueOnce(new TypeError('offline'))
			.mockResolvedValue(status(['en', 'zh']));
		await expect(fetchDictionaryStatus()).rejects.toThrow('offline');
		expect((await fetchDictionaryStatus()).directions).toHaveLength(1);
		await fetchDictionaryStatus();

		expect(request).toHaveBeenCalledTimes(2);
		expect(request).toHaveBeenLastCalledWith('/dictionary/status');
	});

	it('maps request failures to translated messages', () => {
		const problem = (code: number) => new ApiError(code, '', '{}', { status: code });
		expect(dictionaryErrorKey(problem(400))).toBe('dict.error.invalid');
		expect(dictionaryErrorKey(problem(401))).toBe('dict.error.session');
		expect(dictionaryErrorKey(problem(500))).toBe('dict.error.api');
		expect(dictionaryErrorKey(new TypeError('offline'))).toBe('dict.error.connection');
	});

	it('defines the same dictionary translations in English and Chinese', () => {
		const pick = (messages: Record<string, string>) => Object.keys(messages).filter((key) => key.startsWith('dict.')).sort();
		expect(pick(en).length).toBeGreaterThan(10);
		expect(pick(zh)).toEqual(pick(en));
	});
});
