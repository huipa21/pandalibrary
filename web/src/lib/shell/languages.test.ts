import { describe, expect, it } from 'vitest';
import { filterLanguages, suggestedLocales } from './languages.js';

describe('suggestedLocales', () => {
	it('puts the current locale first and de-duplicates browser matches', () => {
		expect(suggestedLocales('zh', ['en-US', 'zh-CN', 'en', 'fr'])).toEqual(['zh', 'en']);
	});

	it('ignores unsupported current and browser locales', () => {
		expect(suggestedLocales('fr', ['fr-FR', 'de-DE'])).toEqual([]);
	});
});

describe('filterLanguages', () => {
	it('matches names and codes without case or accent sensitivity', () => {
		expect(filterLanguages('english', 'en').map(({ code }) => code)).toEqual(['en']);
		expect(filterLanguages('simplified chinese', 'en').map(({ code }) => code)).toEqual(['zh']);
		expect(filterLanguages('símplified chinese', 'en').map(({ code }) => code)).toEqual(['zh']);
		expect(filterLanguages('zh', 'en').map(({ code }) => code)).toEqual(['zh']);
	});

	it('matches Chinese names in the Chinese UI locale', () => {
		expect(filterLanguages('英语', 'zh').map(({ code }) => code)).toEqual(['en']);
	});
});
