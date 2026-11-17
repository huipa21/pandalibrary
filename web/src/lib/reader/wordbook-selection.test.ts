import { describe, expect, it, vi } from 'vitest';
import {
	captureWordbookSelection, orderWordbookDestinations, pdfWordbookSelection, readWordbookUsage,
	recordWordbookUsage, selectionKind, wordbookEntry, writeWordbookUsage
} from './wordbook-selection.js';
import type { ReaderSelection } from './types.js';
import type { Wordbook } from '#lib/wordbooks/api.js';

describe('wordbook selection capture', () => {
	it.each([
		['word', 'word'], ['two words', 'phrase'], ['你好', 'word'],
		['One sentence.', 'sentence'], ['你好！', 'sentence'], ['“Hello!”', 'sentence'],
		['First paragraph.\n\nSecond paragraph.', 'passage'], ['wrapped\nphrase', 'phrase']
	] as const)('classifies %j as %s', (text, kind) => expect(selectionKind(text)).toBe(kind));

	it('recognizes multiple reflow paragraph nodes even without blank lines', () => {
		expect(selectionKind('First\nSecond', 2)).toBe('passage');
	});

	it('captures an independent exact source and supports explicit CJK phrase/passage kinds', () => {
		const selection: ReaderSelection = {
			text: ' 中文短语 ', locator: { type: 'cfi', value: 'epubcfi(/6/2!/4/2,1,8)' },
			fraction: 0.321, chapter: '第三章'
		};
		const captured = captureWordbookSelection(new Proxy(selection, {}))!;
		selection.text = 'Changed';
		selection.locator = { type: 'cfi', value: 'epubcfi(/6/4)' };
		const entry = wordbookEntry(captured, { id: 21, title: 'Book' }, 31, 'phrase');
		expect(entry).toEqual({
			kind: 'phrase', text: ' 中文短语 ', source: {
				book_id: 21, book_file_id: 31, book_title: 'Book',
				locator: { type: 'cfi', value: 'epubcfi(/6/2!/4/2,1,8)' }, fraction: 0.321, chapter: '第三章'
			}
		});
		expect(wordbookEntry(captured, { id: 21, title: 'Book' }, 31, 'passage').kind).toBe('passage');
		expect(entry).not.toHaveProperty('wordbook_id');
		expect(entry).not.toHaveProperty('note');
		expect(entry).not.toHaveProperty('dictionary_entries');
	});

	it('captures every PDF page part, first-page fraction and exact original text', () => {
		const rect = { x: 0.1, y: 0.25, width: 0.5, height: 0.05 };
		const selected = {
			text: 'normalized text', anchor: { left: 1, top: 2, right: 3, bottom: 4 },
			parts: [{ page: 2, text: 'first', rects: [rect] }, { page: 3, text: 'second', rects: [rect] }]
		};
		const captured = pdfWordbookSelection(selected, 5, 'first\n\nsecond')!;
		rect.y = 0.8;
		expect(captured).toMatchObject({
			text: 'first\n\nsecond', fraction: 0.3125,
			locator: { type: 'pdf', page: 2, rects: [{ y: 0.25 }], parts: [{ page: 2 }, { page: 3 }] }
		});
		expect(selectionKind(captured.text)).toBe('passage');
	});

	it('rejects collapsed/empty selections', () => {
		expect(captureWordbookSelection(null)).toBeNull();
		expect(captureWordbookSelection({ text: ' \n', fraction: 0, locator: { type: 'pdf', page: 1 } })).toBeNull();
		expect(pdfWordbookSelection(null, 1)).toBeNull();
	});
});

describe('wordbook destination ordering', () => {
	const book = (id: number, is_default = false): Wordbook => ({
		id, name: `Book ${id}`, description: '', entry_count: 0, book_count: 0,
		is_default, archived: false, created_at: '', updated_at: ''
	});

	it('puts the last used destination first, then the most frequently used', () => {
		const books = [book(1, true), book(2), book(3), book(4)];
		const usage = { lastDestination: 3, destinationCounts: { '2': 5, '3': 2, '4': 1 } };
		expect(orderWordbookDestinations(books, usage).map((item) => item.id)).toEqual([3, 2, 4, 1]);
	});

	it('keeps the default-first server order when there is no history', () => {
		const books = [book(1, true), book(2), book(3)];
		expect(orderWordbookDestinations(books, { destinationCounts: {} }).map((item) => item.id)).toEqual([1, 2, 3]);
	});

	it('records the last destination and its frequency in restricted storage safely', () => {
		const values = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value)
		});
		expect(readWordbookUsage()).toEqual({ destinationCounts: {} });
		let usage = recordWordbookUsage(readWordbookUsage(), 4);
		usage = recordWordbookUsage(usage, 2);
		usage = recordWordbookUsage(usage, 4);
		writeWordbookUsage(usage);
		expect(readWordbookUsage()).toEqual({ lastDestination: 4, destinationCounts: { '4': 2, '2': 1 } });
		vi.stubGlobal('localStorage', { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } });
		expect(readWordbookUsage()).toEqual({ destinationCounts: {} });
		expect(() => writeWordbookUsage(usage)).not.toThrow();
		vi.unstubAllGlobals();
	});
});
