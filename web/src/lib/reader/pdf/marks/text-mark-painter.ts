import { HIGHLIGHT_HEX, highlightColor, isHighlightStyle, type HighlightColor } from '../../annotations.js';
import { isPdfLocator, type Highlight, type HighlightStyle, type Note } from '../../types.js';
import type { NormalizedRect, PageLayerPainter } from '../types.js';

export interface TextMark {
	id: string;
	page: number;
	rects: NormalizedRect[];
	color: HighlightColor;
	style: HighlightStyle;
	createdAt: string;
	hasNote: boolean;
}

/** Live PDF marks of one file, oldest first, so that the newest mark is painted on top. */
export function textMarks(highlights: readonly Highlight[], notes: readonly Note[], fileId: number | null | undefined): TextMark[] {
	if (fileId === null || fileId === undefined) return [];
	const commented = new Set(notes.filter((note) => !note.deleted_at && note.highlight_id && note.body_md.trim())
		.map((note) => note.highlight_id));
	return highlights
		.filter((row) => !row.deleted_at && row.book_file_id === fileId && isPdfLocator(row.locator) && row.locator.rects?.length)
		.map((row) => {
			const locator = row.locator as { page: number; rects: NormalizedRect[] };
			return {
				id: row.id,
				page: locator.page,
				rects: locator.rects,
				color: highlightColor(row.color),
				style: isHighlightStyle(row.style) ? row.style : 'highlight',
				createdAt: row.created_at,
				hasNote: commented.has(row.id)
			} satisfies TextMark;
		})
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function signature(mark: TextMark): string {
	return JSON.stringify([mark.page, mark.color, mark.style, mark.hasNote, mark.createdAt, mark.rects]);
}

/** Pages whose marks differ between two paints; `previous` maps mark id → `page|signature`. */
export function changedPages(previous: ReadonlyMap<string, string>, marks: readonly TextMark[]): {
	pages: Set<number>;
	signatures: Map<string, string>;
} {
	const signatures = new Map<string, string>();
	const pages = new Set<number>();
	for (const mark of marks) {
		const next = `${mark.page}|${signature(mark)}`;
		signatures.set(mark.id, next);
		const before = previous.get(mark.id);
		if (before !== next) {
			pages.add(mark.page);
			if (before) pages.add(Number(before.slice(0, before.indexOf('|'))));
		}
	}
	for (const [id, before] of previous) {
		if (!signatures.has(id)) pages.add(Number(before.slice(0, before.indexOf('|'))));
	}
	return { pages, signatures };
}

/** Replaces the engine's default `highlight` painter: fills, underlines, strikeouts and comment markers. */
export function textMarkPainter(marks: () => readonly TextMark[], commentLabel: () => string): PageLayerPainter {
	return {
		name: 'highlight',
		z: 3,
		paint({ page, layer, toCss }) {
			const label = commentLabel();
			const painted = document.createDocumentFragment();
			for (const mark of marks()) {
				if (mark.page !== page) continue;
				for (const rect of mark.rects) {
					const element = document.createElement('span');
					element.className = 'reader-pdf-highlight';
					element.dataset.annotationId = mark.id;
					element.dataset.style = mark.style;
					const { left, top, width, height } = toCss(rect);
					element.setAttribute('style', `left:${left};top:${top};width:${width};height:${height};--pv-mark:${HIGHLIGHT_HEX[mark.color]}`);
					painted.append(element);
				}
				const last = mark.rects.at(-1);
				if (mark.hasNote && last) {
					const marker = document.createElement('button');
					marker.type = 'button';
					marker.tabIndex = -1;
					marker.className = 'pv-mark-comment';
					marker.dataset.annotationId = mark.id;
					marker.setAttribute('aria-label', label);
					marker.title = label;
					marker.style.left = `${(last.x + last.width) * 100}%`;
					marker.style.top = `${last.y * 100}%`;
					marker.style.setProperty('--pv-mark', HIGHLIGHT_HEX[mark.color]);
					painted.append(marker);
				}
			}
			layer.append(painted);
		}
	};
}
