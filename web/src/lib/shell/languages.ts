import { locales, type Locale } from '#lib/paraglide/runtime.js';

export interface Language {
	code: Locale;
	nativeName: string;
	messageKey: `hm1.language.name.${Locale}`;
	localizedNames: Record<Locale, string>;
}

export const languageTable: readonly Language[] = [
	{
		code: 'en',
		nativeName: 'English',
		messageKey: 'hm1.language.name.en',
		localizedNames: { en: 'English', zh: '英语' }
	},
	{
		code: 'zh',
		nativeName: '简体中文',
		messageKey: 'hm1.language.name.zh',
		localizedNames: { en: 'Simplified Chinese', zh: '简体中文' }
	}
];

export function suggestedLocales(current: string, navigatorLanguages: readonly string[]): Locale[] {
	const matches: Locale[] = [];
	const add = (locale: string) => {
		if (locales.includes(locale as Locale) && !matches.includes(locale as Locale)) {
			matches.push(locale as Locale);
		}
	};

	add(current);
	for (const language of navigatorLanguages) {
		const primary = language.trim().split(/[-_]/, 1)[0].toLowerCase();
		if (primary) add(primary);
	}
	return matches;
}

function normalize(value: string): string {
	return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

export function filterLanguages(query: string, uiLocale: Locale): Language[] {
	const needle = normalize(query.trim());
	return languageTable
		.filter((language) => {
			if (!needle) return true;
			return [language.nativeName, language.localizedNames[uiLocale], language.code]
				.some((value) => normalize(value).includes(needle));
		})
		.sort((a, b) => a.nativeName.localeCompare(b.nativeName));
}
