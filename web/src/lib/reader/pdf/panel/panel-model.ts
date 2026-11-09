import { buildMarks, foldText } from '#lib/bookview/highlights/highlights-model.js';
import { isPdfLocator, type Bookmark, type Highlight, type HighlightStyle, type NormalizedRect, type Note, type PageAnnotation } from '../../types.js';

interface EntryBase {
	id: string;
	page: number | null;
	y: number;
	rect?: NormalizedRect;
	createdAt: string;
	excerpt: string;
}

export type PanelEntry = EntryBase & (
	| { kind: 'mark'; row: Highlight; style: HighlightStyle; color: string; notes: Note[]; commentExcerpt: string }
	| { kind: 'bookmark'; row: Bookmark }
	| { kind: 'text' | 'ink' | 'image'; row: PageAnnotation }
);
export type PanelFilter = 'all' | 'marks' | 'comments' | 'bookmarks' | 'inserts';
export const PANEL_FILTERS: PanelFilter[] = ['all', 'marks', 'comments', 'bookmarks', 'inserts'];

export function excerpt(text: string): string {
	const chars = Array.from(text);
	return chars.length > 160 ? chars.slice(0, 160).join('') + '…' : text;
}

export function filterEntries(entries: readonly PanelEntry[], kind: PanelFilter, query: string): PanelEntry[] {
	const search = foldText(query.trim());
	return entries.filter((entry) => {
		if (kind === 'marks' && entry.kind !== 'mark') return false;
		if (kind === 'comments' && (entry.kind !== 'mark' || !entry.notes.length)) return false;
		if (kind === 'bookmarks' && entry.kind !== 'bookmark') return false;
		if (kind === 'inserts' && (entry.kind === 'mark' || entry.kind === 'bookmark')) return false;
		const text = entry.kind === 'mark'
			? `${entry.row.text}\n${entry.notes.map((note) => note.body_md).join('\n')}`
			: entry.kind === 'bookmark' ? entry.row.label
				: entry.row.kind === 'text' ? entry.row.data.text : '';
		return !search || foldText(text).includes(search);
	});
}

export function buildPanel(input: {
	highlights: readonly Highlight[];
	notes: readonly Note[];
	bookmarks: readonly Bookmark[];
	pageAnnotations: readonly PageAnnotation[];
	fileId: number;
	format: 'pdf';
}) {
	const entries: PanelEntry[] = [];
	const otherFile: PanelEntry[] = [];
	const liveNotes = input.notes.filter((note) => !note.deleted_at);
	function add(entry: PanelEntry) {
		(entry.row.book_file_id === input.fileId && entry.page !== null ? entries : otherFile).push(entry);
	}
	for (const row of buildMarks(input.highlights, input.notes)) {
		const locator = isPdfLocator(row.locator) ? row.locator : null;
		const rect = locator?.rects?.[0];
		const notes = row.notes;
		add({
			id: row.id, kind: 'mark', row, page: locator?.page ?? null, y: rect?.y ?? 0, rect,
			createdAt: row.created_at, excerpt: excerpt(row.text), style: row.style ?? 'highlight', color: row.color,
			notes, commentExcerpt: excerpt(notes.map((note) => note.body_md).join('\n'))
		});
	}
	for (const row of input.bookmarks) {
		if (row.deleted_at) continue;
		const locator = isPdfLocator(row.locator) ? row.locator : null;
		const rect = locator?.rects?.[0];
		add({ id: row.id, kind: 'bookmark', row, page: locator?.page ?? null, y: rect?.y ?? 0, rect, createdAt: row.created_at, excerpt: excerpt(row.label) });
	}
	for (const row of input.pageAnnotations) {
		if (row.deleted_at) continue;
		add({
			id: row.id, kind: row.kind, row, page: row.locator.page, y: row.locator.rect.y,
			rect: row.locator.rect, createdAt: row.created_at,
			excerpt: row.kind === 'text' ? excerpt(row.data.text) : ''
		});
	}
	const compare = (a: PanelEntry, b: PanelEntry) =>
		(a.page ?? Infinity) - (b.page ?? Infinity) || a.y - b.y ||
		a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
	entries.sort(compare);
	otherFile.sort(compare);
	const groups: { page: number; entries: PanelEntry[] }[] = [];
	for (const entry of entries) {
		if (entry.page === null) continue;
		let group = groups.at(-1);
		if (group?.page !== entry.page) {
			group = { page: entry.page, entries: [] };
			groups.push(group);
		}
		group.entries.push(entry);
	}
	return {
		groups, otherFile, bookNotes: liveNotes.filter((note) => note.highlight_id === null),
		counts: {
			all: entries.length,
			marks: entries.filter((entry) => entry.kind === 'mark').length,
			comments: entries.filter((entry) => entry.kind === 'mark' && entry.notes.length > 0).length,
			bookmarks: entries.filter((entry) => entry.kind === 'bookmark').length,
			inserts: entries.filter((entry) => entry.kind !== 'mark' && entry.kind !== 'bookmark').length
		}
	};
}
