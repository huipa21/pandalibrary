import type { DictionaryEntry } from '#lib/dictionary/types.js';
import type { WordbookEntry } from './api.js';

export function truncatePreview(text: string, limit = 100): string {
	const characters = Array.from(text.replace(/\s+/gu, ' ').trim());
	return characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : characters.join('');
}

function primaryLanguage(language = ''): string {
	return language.trim().split('-')[0].toLowerCase();
}

// Wiktionary editions contain multiple source languages; Han-only headwords
// cannot distinguish Chinese from Japanese, so do not guess their direction.
export function snapshotDirection(snapshot: DictionaryEntry): { from?: string; to?: string } {
	let from: string | undefined;
	let to: string | undefined;
	if (snapshot.source === 'ecdict') { from = 'en'; to = 'zh'; }
	else if (snapshot.source === 'cc-cedict') { from = 'zh'; to = 'en'; }
	else if (snapshot.source === 'jmdict' || /^wiktionary-(en|zh|ja)$/.test(snapshot.source)) {
		const japanese = /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(snapshot.headword + (snapshot.reading ?? ''));
		const english = /^[\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}]+$/u.test(snapshot.headword)
			&& /\p{Script=Latin}/u.test(snapshot.headword);
		from = japanese ? 'ja' : english ? 'en' : undefined;
		if (snapshot.source === 'jmdict') {
			// JMdict imports Japanese records and reverse English short glosses.
			if (!from && /\p{Script=Han}/u.test(snapshot.headword)) from = 'ja';
			to = from === 'ja' ? 'en' : from === 'en' ? 'ja' : undefined;
		} else to = snapshot.source.slice('wiktionary-'.length);
	}
	return { from: snapshot.from || from, to: snapshot.to || to };
}

export function appropriateSnapshots(
	snapshots: readonly DictionaryEntry[], language = '', meaningLanguage = ''
): DictionaryEntry[] {
	const source = primaryLanguage(language);
	const target = primaryLanguage(meaningLanguage) || source;
	return snapshots.filter((snapshot) => {
		const direction = snapshotDirection(snapshot);
		return (!source || primaryLanguage(direction.from) === source)
			&& (!target || primaryLanguage(direction.to) === target);
	});
}

export function entryPreview(entry: WordbookEntry, language = '', meaningLanguage = '') {
	const snapshots = appropriateSnapshots(entry.dictionary_entries, language, meaningLanguage);
	const source = primaryLanguage(language);
	// Readings/POS belong to the headword, even when its translation target differs.
	const metadata = source
		? entry.dictionary_entries.filter((snapshot) => primaryLanguage(snapshotDirection(snapshot).from) === source)
		: entry.dictionary_entries;
	const reading = metadata.find((snapshot) => snapshot.reading?.trim())?.reading?.trim() ?? '';
	const partOfSpeech = metadata.find((snapshot) => snapshot.partOfSpeech?.trim())?.partOfSpeech?.trim() ?? '';
	const lexical = entry.kind === 'word' || entry.kind === 'phrase';
	return {
		text: truncatePreview(entry.text),
		reading,
		metadata: [partOfSpeech, reading].filter(Boolean).join(' · '),
		meaning: lexical
			? entry.definition.trim() || snapshots.flatMap((snapshot) => snapshot.definitions).find((meaning) => meaning.trim()) || ''
			: entry.note,
		speechLanguage: language || (metadata[0] ? snapshotDirection(metadata[0]).from : '') || ''
	};
}
