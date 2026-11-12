import { describe, expect, it, vi } from 'vitest';
import { bookmarkExcerpt, firstVisibleLine } from './foliate-bookmarks.js';

describe('Foliate bookmark excerpts', () => {
	it('normalizes whitespace and truncates by UTF-8 bytes without splitting characters', () => {
		expect(bookmarkExcerpt(' \n Selected\t text  ')).toBe('Selected text');
		const excerpt = bookmarkExcerpt('书😀'.repeat(100));
		expect(new TextEncoder().encode(excerpt).length).toBeLessThanOrEqual(512);
		expect(excerpt).not.toContain('\uFFFD');
		expect(excerpt).toBe('书😀'.repeat(73));
	});

	for (const vertical of [false, true]) {
		it(`extracts only the first rendered ${vertical ? 'vertical' : 'horizontal'} visible line`, () => {
			let offset = 0;
			const doc = {
				createTreeWalker: vi.fn(),
				createRange: () => ({
					setStart: (_node: Node, next: number) => { offset = next; },
					setEnd: vi.fn(),
					getClientRects: () => [{
						width: 10, height: 10, top: vertical ? 0 : offset < 14 ? 0 : 20,
						right: vertical && offset >= 14 ? 20 : 0
					}]
				}),
				defaultView: { getComputedStyle: () => ({ writingMode: vertical ? 'vertical-rl' : 'horizontal-tb' }) }
			};
			const node = { nodeType: 3, nodeValue: 'HiddenPage onePage two', ownerDocument: doc };
			const range = {
				startContainer: node, endContainer: node, commonAncestorContainer: node,
				startOffset: 6, endOffset: node.nodeValue.length
			};
			expect(firstVisibleLine(range as unknown as Range)).toBe('Page one');
		});
	}
});
