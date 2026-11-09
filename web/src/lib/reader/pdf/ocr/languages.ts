export type OcrLanguage = 'chi_sim' | 'eng';

export function ocrLanguagesFor(language: string | null | undefined): OcrLanguage[] {
	return /^en/i.test(language?.trim() ?? '') ? ['eng'] : ['chi_sim', 'eng'];
}

export function languageKey(languages: readonly OcrLanguage[]): string {
	if (!languages.length) throw new Error('At least one OCR language is required.');
	return [...new Set(languages)].sort().join('+');
}
