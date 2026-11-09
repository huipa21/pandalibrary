import { clampRect, fromRotated, mergeLineRects } from '../geometry.js';
import type { NormalizedRect, PdfRotation } from '../types.js';
import { unionRect, type RectLike } from './floating.js';

export const MAX_PART_RECTS = 200;

export interface PdfSelectionPart {
	page: number;
	/** Unrotated, normalized, merged per line. */
	rects: NormalizedRect[];
	text: string;
}

export interface PdfSelection {
	parts: PdfSelectionPart[];
	text: string;
	/** Client rect of the selection's last line. */
	anchor: RectLike;
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CJK_BREAK = new RegExp(`([${CJK}])\\s*\\n\\s*(?=[${CJK}])`, 'gu');

/** Trims each line, collapses spaces, drops empty lines; CJK lines are joined without a break. */
export function normalizeSelectionText(text: string): string {
	return text.replace(/\r\n?/g, '\n').replace(CJK_BREAK, '$1').split('\n')
		.map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
		.filter(Boolean)
		.join('\n');
}

/**
 * Converts client rects of selected text on one page to normalized rects in the unrotated page space.
 * `bounds` is the client rect of the (rotated) page box.
 */
export function toPageRects(clientRects: Iterable<RectLike>, bounds: RectLike, rotation: PdfRotation): NormalizedRect[] {
	const width = bounds.right - bounds.left;
	const height = bounds.bottom - bounds.top;
	if (width <= 0 || height <= 0) return [];
	const rects: NormalizedRect[] = [];
	for (const rect of clientRects) {
		const left = Math.max(0, rect.left - bounds.left);
		const top = Math.max(0, rect.top - bounds.top);
		const right = Math.min(width, rect.right - bounds.left);
		const bottom = Math.min(height, rect.bottom - bounds.top);
		if (right - left < 0.5 || bottom - top < 0.5) continue;
		const normalized = clampRect(fromRotated({
			x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height
		}, rotation));
		if (normalized.width > 0 && normalized.height > 0) rects.push(normalized);
	}
	return mergeLineRects(rects).map(round).filter((rect) => rect.width > 0 && rect.height > 0).slice(0, MAX_PART_RECTS);
}

function round(rect: NormalizedRect): NormalizedRect {
	const r = (value: number) => Math.round(value * 1e5) / 1e5;
	const x = r(rect.x);
	const y = r(rect.y);
	return { x, y, width: Math.min(r(rect.width), 1 - x), height: Math.min(r(rect.height), 1 - y) };
}

/** The union of the rects that share the last rect's line (more than half vertical overlap). */
export function lastLine(rects: readonly RectLike[]): RectLike | null {
	const last = rects.at(-1);
	if (!last) return null;
	const height = last.bottom - last.top;
	return unionRect(rects.filter((rect) => {
		const overlap = Math.min(rect.bottom, last.bottom) - Math.max(rect.top, last.top);
		return overlap > 0.5 * Math.min(height, rect.bottom - rect.top);
	}));
}

function textNodes(root: Node): Text[] {
	const nodes: Text[] = [];
	const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.textContent) nodes.push(node as Text);
	}
	return nodes;
}

/** Client rects of the text nodes inside `range`; element boxes (e.g. pdf.js `endOfContent`) are skipped. */
function textRects(range: Range, nodes: Text[]): DOMRect[] {
	const rects: DOMRect[] = [];
	for (const node of nodes) {
		if (!range.intersectsNode(node)) continue;
		const part = node.ownerDocument.createRange();
		part.selectNodeContents(node);
		if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
		if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
		if (part.collapsed) continue;
		for (const rect of Array.from(part.getClientRects())) {
			if (rect.width > 0 && rect.height > 0) rects.push(rect);
		}
	}
	return rects;
}

/**
 * Splits a DOM selection into per-page parts. Each page text layer (pdf.js `.textLayer` or the OCR
 * `.pv-ocr-text`, which also carries `.textLayer`) gets a sub-range clamped to the layer, because
 * `Range.getClientRects()` cannot be grouped by page afterwards.
 */
export function capturePdfSelection(
	selection: Selection | null,
	engine: { readonly viewport: HTMLElement; readonly state: { rotation: PdfRotation } }
): PdfSelection | null {
	if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
	const range = selection.getRangeAt(0);
	const root = engine.viewport;
	if (!range.intersectsNode(root)) return null;
	const rotation = engine.state.rotation;
	const pages = new Map<number, { div: HTMLElement; clientRects: DOMRect[]; texts: string[] }>();
	for (const layer of root.querySelectorAll<HTMLElement>('.page[data-page-number] .textLayer')) {
		if (!range.intersectsNode(layer)) continue;
		const div = layer.closest<HTMLElement>('.page[data-page-number]')!;
		const page = Number(div.dataset.pageNumber);
		const nodes = textNodes(layer);
		if (!page || !nodes.length) continue;
		const sub = range.cloneRange();
		if (!layer.contains(range.startContainer)) sub.setStart(nodes[0], 0);
		if (!layer.contains(range.endContainer)) sub.setEnd(nodes.at(-1)!, nodes.at(-1)!.length);
		if (sub.collapsed) continue;
		const text = normalizeSelectionText(sub.toString());
		if (!text) continue;
		const entry = pages.get(page) ?? { div, clientRects: [], texts: [] };
		entry.clientRects.push(...textRects(sub, nodes));
		entry.texts.push(text);
		pages.set(page, entry);
	}
	const parts: PdfSelectionPart[] = [];
	let lastRects: DOMRect[] = [];
	for (const [page, entry] of [...pages].sort(([a], [b]) => a - b)) {
		const rects = toPageRects(entry.clientRects, entry.div.getBoundingClientRect(), rotation);
		if (!rects.length) continue;
		parts.push({ page, rects, text: entry.texts.join('\n') });
		lastRects = entry.clientRects;
	}
	const anchor = lastLine(lastRects);
	if (!parts.length || !anchor) return null;
	return { parts, text: parts.map((part) => part.text).join('\n'), anchor };
}
