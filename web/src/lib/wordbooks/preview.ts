import type { DictionaryEntry } from '#lib/dictionary/types.js';
import type { WordbookEntry } from './api.js';

export function truncatePreview(text: string, limit = 100): string {
	const characters = Array.from(text.replace(/\s+/gu, ' ').trim());
	return characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : characters.join('');
}

function primaryLanguage(language = ''): string {
	return language.trim().split('-')[0].toLowerCase();
}

function isRomanization(snapshot: DictionaryEntry): boolean {
	return snapshot.partOfSpeech?.trim().toLowerCase() === 'romanization';
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
	snapshots: readonly DictionaryEntry[], language = '', meaningLanguage: string | readonly string[] = ''
): DictionaryEntry[] {
	const source = primaryLanguage(language);
	const targets = (typeof meaningLanguage === 'string' ? [meaningLanguage] : meaningLanguage)
		.map(primaryLanguage).filter(Boolean);
	if (!targets.length && source) targets.push(source);
	return snapshots.filter((snapshot) => {
		if (isRomanization(snapshot)) return false;
		const direction = snapshotDirection(snapshot);
		return (!source || primaryLanguage(direction.from) === source)
			&& (!targets.length || targets.includes(primaryLanguage(direction.to)));
	});
}

export function entryPreview(entry: WordbookEntry, language = '', meaningLanguage: string | readonly string[] = '') {
	const snapshots = appropriateSnapshots(entry.dictionary_entries, language, meaningLanguage);
	const source = primaryLanguage(language);
	// Readings/POS belong to the headword, even when its translation target differs.
	const metadata = entry.dictionary_entries.filter((snapshot) => !isRomanization(snapshot)
		&& (!source || primaryLanguage(snapshotDirection(snapshot).from) === source));
	const reading = metadata.find((snapshot) => snapshot.reading?.trim())?.reading?.trim() ?? '';
	const partOfSpeech = metadata.find((snapshot) => snapshot.partOfSpeech?.trim())?.partOfSpeech?.trim() ?? '';
	const lexical = entry.kind === 'word' || entry.kind === 'phrase';
	const meanings = [...new Set(snapshots.flatMap((snapshot) => snapshot.definitions)
		.filter((meaning) => meaning.trim()))];
	return {
		text: truncatePreview(entry.text),
		reading,
		metadata: [partOfSpeech, reading].filter(Boolean).join(' · '),
		meanings: lexical ? (entry.definition.trim() ? [entry.definition] : meanings) : (entry.note ? [entry.note] : []),
		speechLanguage: language || (metadata[0] ? snapshotDirection(metadata[0]).from : '') || ''
	};
}
