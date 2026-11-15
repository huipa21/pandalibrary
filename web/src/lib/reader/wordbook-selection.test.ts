import { describe, expect, it } from 'vitest';
import { captureWordbookSelection, pdfWordbookSelection, selectionKind, wordbookEntry } from './wordbook-selection.js';
import type { ReaderSelection } from './types.js';

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
