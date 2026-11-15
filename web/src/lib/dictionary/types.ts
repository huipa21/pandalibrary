export type DictionaryLanguage = 'en' | 'zh' | 'ja';

export type DictionaryMatch = 'exact' | 'lemma' | 'prefix';

export interface DictionaryDirection {
	from: DictionaryLanguage;
	to: DictionaryLanguage;
	sources: string[];
}

export interface DictionarySource {
	id: string;
	name: string;
	license: string;
	url: string;
	entries: number;
	importedAt: number;
}

export interface DictionaryStatus {
	directions: DictionaryDirection[];
	sources: DictionarySource[];
}

export interface DictionaryEntry {
	from?: string;
	to?: string;
	source: string;
	sourceName: string;
	headword: string;
	reading?: string;
	partOfSpeech?: string;
	definitions: string[];
	match: DictionaryMatch;
}

export interface DictionaryResult {
	query: string;
	term: string;
	from: DictionaryLanguage;
	to: DictionaryLanguage;
	entries: DictionaryEntry[];
}
