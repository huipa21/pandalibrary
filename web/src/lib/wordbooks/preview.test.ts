import { describe, expect, it } from 'vitest';
import type { DictionaryEntry } from '#lib/dictionary/types.js';
import type { WordbookEntry } from './api.js';
import { appropriateSnapshots, entryPreview, snapshotDirection, truncatePreview } from './preview.js';

const snapshot = (source: string, headword = 'apple', extra: Partial<DictionaryEntry> = {}): DictionaryEntry => ({
	source, sourceName: source, headword, definitions: ['First meaning', 'Second meaning'], match: 'exact', ...extra
});
const entry = (extra: Partial<WordbookEntry> = {}): WordbookEntry => ({
	id: 1, wordbook_id: 1, text: 'apple', kind: 'word', definition: '', note: '',
	source: { book_id: null, book_file_id: null, book_title: 'Source', locator: null, fraction: 0 },
	dictionary_entries: [], created_at: '', updated_at: '', ...extra
});

describe('compact entry preview', () => {
	it('includes all selected meaning languages without changing source filtering or manual meanings', () => {
		const snapshots = [
			snapshot('custom', 'apple', { from: 'en', to: 'en', definitions: ['A fruit'] }),
			snapshot('ecdict', 'apple', { definitions: ['苹果'] }),
			snapshot('custom', 'apple', { from: 'en', to: 'ja', definitions: ['りんご'] }),
			snapshot('jmdict', 'りんご', { definitions: ['wrong source'] })
		];
		expect(appropriateSnapshots(snapshots, 'en', ['ZH-hant', 'ja'])).toEqual([snapshots[1], snapshots[2]]);
		expect(appropriateSnapshots(snapshots, 'en', [])).toEqual([snapshots[0]]);
		const input = entry({ dictionary_entries: snapshots });
		expect(entryPreview(input, 'en', ['zh', 'ja']).meaning).toBe('苹果 · りんご');
		expect(entryPreview({ ...input, definition: 'Custom' }, 'en', ['zh', 'ja']).meaning).toBe('Custom');
	});

	it('limits Unicode code points including the ellipsis without splitting surrogate pairs', () => {
		const full = '🍎'.repeat(101);
		const preview = truncatePreview(full);
		expect(Array.from(preview)).toHaveLength(100);
		expect(preview).toBe('🍎'.repeat(99) + '…');
		expect(truncatePreview('🍎'.repeat(100))).toBe('🍎'.repeat(100));
		expect(truncatePreview(' first\nsecond\tthird ')).toBe('first second third');
	});

	it('filters source and target, defaulting target to the selected source language', () => {
		const english = snapshot('custom', 'apple', { from: 'en', to: 'en' });
		const chinese = snapshot('ecdict');
		const japanese = snapshot('jmdict', 'りんご');
		const snapshots = [japanese, chinese, english, snapshot('unknown')];
		expect(appropriateSnapshots(snapshots, 'en')).toEqual([english]);
		expect(appropriateSnapshots(snapshots, 'en', 'zh')).toEqual([chinese]);
		expect(appropriateSnapshots(snapshots, 'ja', 'en')).toEqual([japanese]);
		expect(appropriateSnapshots(snapshots)).toEqual(snapshots);
		expect(appropriateSnapshots(snapshots, '', 'en')).toEqual([japanese, english]);
	});

	it('uses importer directions conservatively for historical snapshots', () => {
		expect(snapshotDirection(snapshot('cc-cedict', '苹果'))).toEqual({ from: 'zh', to: 'en' });
		expect(snapshotDirection(snapshot('jmdict', 'apple'))).toEqual({ from: 'en', to: 'ja' });
		expect(snapshotDirection(snapshot('jmdict', '林檎'))).toEqual({ from: 'ja', to: 'en' });
		expect(snapshotDirection(snapshot('wiktionary-zh'))).toEqual({ from: 'en', to: 'zh' });
		expect(snapshotDirection(snapshot('wiktionary-en', 'りんご'))).toEqual({ from: 'ja', to: 'en' });
		expect(appropriateSnapshots([snapshot('wiktionary-en', '林檎')], 'zh', 'en')).toEqual([]);
		expect(snapshotDirection(snapshot('ecdict', 'apple', { from: 'ja', to: 'ja' }))).toEqual({ from: 'ja', to: 'ja' });
	});

	it('matches BCP47 primary languages case-insensitively while preserving the speech tag', () => {
		const chinese = snapshot('ecdict', 'apple', { reading: 'ˈæpəl', partOfSpeech: 'noun', definitions: ['苹果'] });
		const english = snapshot('custom', 'apple', { from: 'EN-us', to: 'En-GB' });
		const japanese = snapshot('jmdict', 'りんご', { reading: 'wrong reading', partOfSpeech: 'wrong POS' });
		const snapshots = [japanese, chinese, english];
		expect(appropriateSnapshots(snapshots, 'en-GB', 'zh-Hant')).toEqual([chinese]);
		expect(appropriateSnapshots(snapshots, 'EN-gb', 'ZH-hant')).toEqual([chinese]);
		expect(appropriateSnapshots(snapshots, 'en-GB')).toEqual([english]);
		expect(entryPreview(entry({ dictionary_entries: snapshots }), 'en-GB', 'zh-Hant')).toMatchObject({
			meaning: '苹果', metadata: 'noun · ˈæpəl', speechLanguage: 'en-GB'
		});
	});

	it('shows one primary meaning but keeps snapshot data intact, including source readings', () => {
		const input = entry({ dictionary_entries: [
			snapshot('jmdict', 'りんご', { reading: 'wrong reading', partOfSpeech: 'wrong POS' }),
			snapshot('ecdict', 'apple', { reading: 'ˈæpəl', partOfSpeech: 'noun', definitions: ['苹果'] }),
			snapshot('wiktionary-en', 'apple', { definitions: ['A fruit', 'A tree'] })
		] });
		expect(entryPreview(input, 'en')).toMatchObject({ meaning: 'A fruit', metadata: 'noun · ˈæpəl', speechLanguage: 'en' });
		expect(entryPreview(input, 'en', 'zh').meaning).toBe('苹果');
		expect(entryPreview({ ...input, definition: 'My own meaning' }, 'en').meaning).toBe('My own meaning');
		expect(input.dictionary_entries[2].definitions).toEqual(['A fruit', 'A tree']);
		expect(entryPreview(entry({ kind: 'passage', note: 'Full passage note' })).meaning).toBe('Full passage note');
	});
});
