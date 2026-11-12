import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Highlight, Note } from '../../types.js';
import { percentCss } from '../page-layers.js';
import { changedPages, textMarkPainter, textMarks } from './text-mark-painter.js';
import { ocrNeedsRerun } from './ocr-wiring.js';

const rect = { x: 0.1, y: 0.2, width: 0.3, height: 0.02 };

function highlight(id: string, patch: Partial<Highlight> = {}): Highlight {
	return {
		id, book_id: 1, book_file_id: 31, locator: { type: 'pdf', page: 1, rects: [rect] }, position: 0, text: id,
		color: 'yellow', style: 'highlight', chapter: null, created_at: `2024-01-01T00:00:0${id.length}Z`,
		updated_at: '2024-01-01T00:00:00Z', deleted_at: null, rev: 0, ...patch
	};
}

function note(id: string, highlightId: string | null, patch: Partial<Note> = {}): Note {
	return {
		id, book_id: 1, highlight_id: highlightId, body_md: 'Body', created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z', deleted_at: null, rev: 0, ...patch
	};
}

describe('textMarks', () => {
	it('keeps live PDF marks of the file, oldest first', () => {
		const rows = [
			highlight('newer', { created_at: '2024-02-01T00:00:00Z', color: 'blue', style: 'underline' }),
			highlight('older', { created_at: '2024-01-01T00:00:00Z' }),
			highlight('deleted', { deleted_at: '2024-03-01T00:00:00Z' }),
			highlight('other-file', { book_file_id: 32 }),
			highlight('epub', { locator: { type: 'cfi', value: 'epubcfi(/6/2)' } }),
			highlight('no-rects', { locator: { type: 'pdf', page: 2 } })
		];
		const marks = textMarks(rows, [], 31);
		expect(marks.map((mark) => mark.id)).toEqual(['older', 'newer']);
		expect(marks[1]).toMatchObject({ page: 1, color: 'blue', style: 'underline', hasNote: false, rects: [rect] });
	});

	it('keeps stored colours and falls back to the highlight style for unknown styles', () => {
		const [mark] = textMarks([highlight('a', { color: 'teal', style: 'wavy' as never })], [], 31);
		expect(mark).toMatchObject({ color: 'teal', style: 'highlight' });
		expect(textMarks([highlight('hex', { color: '#AABBCC' })], [], 31)[0].color).toBe('#AABBCC');
	});

	it('flags marks with a live, non-empty note', () => {
		const marks = textMarks([highlight('a'), highlight('b'), highlight('c')], [
			note('n1', 'a'),
			note('n2', 'b', { deleted_at: '2024-01-02T00:00:00Z' }),
			note('n3', 'c', { body_md: '   ' }),
			note('n4', null)
		], 31);
		expect(marks.map((mark) => mark.hasNote)).toEqual([true, false, false]);
	});

	it('is empty without a file', () => {
		expect(textMarks([highlight('a')], [], null)).toEqual([]);
	});
});

describe('changedPages', () => {
	const marksOf = (...rows: Highlight[]) => textMarks(rows, [], 31);
	const onPage = (id: string, page: number, patch: Partial<Highlight> = {}) =>
		highlight(id, { locator: { type: 'pdf', page, rects: [rect] }, ...patch });

	it('repaints every page on the first paint', () => {
		expect([...changedPages(new Map(), marksOf(onPage('a', 1), onPage('b', 3))).pages].sort()).toEqual([1, 3]);
	});

	it('repaints only the pages whose marks changed', () => {
		const first = changedPages(new Map(), marksOf(onPage('a', 1), onPage('b', 3)));
		expect([...changedPages(first.signatures, marksOf(onPage('a', 1), onPage('b', 3))).pages]).toEqual([]);
		expect([...changedPages(first.signatures, marksOf(onPage('a', 1, { color: 'green' }), onPage('b', 3))).pages]).toEqual([1]);
		expect([...changedPages(first.signatures, marksOf(onPage('a', 1))).pages]).toEqual([3]);
		expect([...changedPages(first.signatures, marksOf(onPage('a', 2), onPage('b', 3))).pages].sort()).toEqual([1, 2]);
	});

	it('repaints when a note is added', () => {
		const first = changedPages(new Map(), textMarks([onPage('a', 4)], [], 31));
		expect([...changedPages(first.signatures, textMarks([onPage('a', 4)], [note('n', 'a')], 31)).pages]).toEqual([4]);
	});
});

describe('textMarkPainter', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('batches marks and comment markers in paint order with unchanged geometry and labels', () => {
		class Element {
			className = '';
			dataset: Record<string, string> = {};
			attributes: Record<string, string> = {};
			style = { cssText: '', left: '', top: '', setProperty: vi.fn() };
			type = '';
			tabIndex = 0;
			title = '';
			children: Element[] = [];
			constructor(readonly tag: string) {}
			append(child: Element) { this.children.push(child); }
			setAttribute(key: string, value: string) { this.attributes[key] = value; }
			closest() { return null; }
		}
		const layer = new Element('layer');
		vi.stubGlobal('document', {
			createElement: (tag: string) => tag === 'layer' ? layer : new Element(tag),
			createElementNS: (_namespace: string, tag: string) => new Element(tag),
			createDocumentFragment: () => new Element('fragment')
		});
		const marks = textMarks([
			highlight('a', { style: 'underline' }),
			highlight('b', { color: 'blue', locator: { type: 'pdf', page: 2, rects: [rect] } })
		], [note('n', 'a')], 31);
		textMarkPainter(() => marks, () => 'Open comment').paint({
			page: 1, layer: document.createElement('layer'), width: 600, height: 800, rotation: 90,
			toCss: percentCss, fromClient: (x, y) => ({ x, y })
		});
		expect(layer.children).toHaveLength(1);
		const [mark, comment] = layer.children[0].children;
		expect(mark).toMatchObject({
			className: 'reader-pdf-highlight', dataset: { annotationId: 'a', style: 'underline', markColor: '#facc15' },
			attributes: { style: 'left:10%;top:20%;width:30%;height:2%' }
		});
		expect(mark.style.setProperty).toHaveBeenCalledWith('--pv-mark', '#facc15');
		expect(mark.style).toMatchObject({ opacity: '1', mixBlendMode: 'normal' });
		expect(comment).toMatchObject({
			className: 'pv-mark-comment', dataset: { annotationId: 'a' }, attributes: { 'aria-label': 'Open comment' },
			type: 'button', tabIndex: -1, title: 'Open comment', style: { left: '40%', top: '20%' }
		});
		expect(comment.style.setProperty).toHaveBeenCalledWith('--pv-mark', '#facc15');
		expect(comment.children[0]).toMatchObject({
			tag: 'svg', attributes: { viewBox: '0 0 16 16', 'aria-hidden': 'true' }
		});
		expect(comment.children[0].children[0].tag).toBe('path');
	});
});

describe('ocrNeedsRerun', () => {
	it('re-runs when the switch flips', () => {
		expect(ocrNeedsRerun({ enabled: false, tool: 'select' }, { enabled: true, tool: 'select' })).toBe(true);
		expect(ocrNeedsRerun({ enabled: true, tool: 'hand' }, { enabled: false, tool: 'hand' })).toBe(true);
	});

	it('re-runs when switching to Select while enabled', () => {
		expect(ocrNeedsRerun({ enabled: true, tool: 'hand' }, { enabled: true, tool: 'select' })).toBe(true);
		expect(ocrNeedsRerun({ enabled: false, tool: 'hand' }, { enabled: false, tool: 'select' })).toBe(false);
		expect(ocrNeedsRerun({ enabled: true, tool: 'select' }, { enabled: true, tool: 'hand' })).toBe(false);
		expect(ocrNeedsRerun({ enabled: true, tool: 'select' }, { enabled: true, tool: 'select' })).toBe(false);
	});
});
