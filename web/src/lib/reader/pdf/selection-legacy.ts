import { clampRect, fromRotated } from './geometry.js';
import type { NormalizedRect, PdfRotation } from './types.js';

const MAX_RECTS = 200;

function textNodes(range: Range): Text[] {
	const root = range.commonAncestorContainer;
	if (root.nodeType === Node.TEXT_NODE) return [root as Text];
	const nodes: Text[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (range.intersectsNode(node) && node.textContent) nodes.push(node as Text);
	}
	return nodes;
}

/**
 * Normalized, unrotated rects of the selected text within one page. Only text nodes are measured,
 * because element boxes inside a text layer (for example pdf.js's `endOfContent`) can span the page.
 */
export function selectionRects(range: Range, pageDiv: HTMLElement, rotation: PdfRotation): NormalizedRect[] {
	const bounds = pageDiv.getBoundingClientRect();
	if (!bounds.width || !bounds.height) return [];
	const rects: NormalizedRect[] = [];
	for (const node of textNodes(range)) {
		const part = document.createRange();
		part.selectNodeContents(node);
		if (node === range.startContainer) part.setStart(node, range.startOffset);
		if (node === range.endContainer) part.setEnd(node, range.endOffset);
		for (const rect of Array.from(part.getClientRects())) {
			const left = Math.max(0, rect.left - bounds.left);
			const top = Math.max(0, rect.top - bounds.top);
			const right = Math.min(bounds.width, rect.right - bounds.left);
			const bottom = Math.min(bounds.height, rect.bottom - bounds.top);
			if (right - left < 0.5 || bottom - top < 0.5) continue;
			rects.push(clampRect(fromRotated({
				x: left / bounds.width, y: top / bounds.height,
				width: (right - left) / bounds.width, height: (bottom - top) / bounds.height
			}, rotation)));
			if (rects.length > MAX_RECTS) return rects;
		}
	}
	return rects.filter((rect) => rect.width > 0 && rect.height > 0);
}

export { MAX_RECTS };
