import { marked, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';
import { buildMarks, foldText } from '#lib/bookview/highlights/highlights-model.js';
import * as m from '#lib/paraglide/messages.js';
import { resolveMarkColor } from '../../../annotations.js';
import {
	isCfiLocator, isPdfLocator, type Highlight, type HighlightStyle, type NormalizedRect, type Note, type PageAnnotation
} from '../../../types.js';

interface EntryBase {
	id: string;
	page: number | null;
	y: number;
	rect?: NormalizedRect;
	createdAt: string;
	updatedAt: string;
	excerpt: string;
	commentExcerpt: string;
}

export type AnnotationEntry = EntryBase & (
	| {
		kind: 'mark';
		row: Highlight;
		notes: Note[];
		swatch: { kind: 'mark'; style: HighlightStyle; hex: string };
	}
	| {
		kind: 'text' | 'ink' | 'image';
		row: PageAnnotation;
		notes: [];
		swatch: { kind: 'text' | 'ink' | 'image' };
	}
);

/** Collapse whitespace and truncate by Unicode code point, including the ellipsis. */
export function excerpt(value: string, limit = 160): string {
	const text = value.replace(/\s+/gu, ' ').trim();
	const chars = Array.from(text);
	if (chars.length <= limit) return text;
	return `${chars.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`;
}

function tokenText(tokens: readonly Token[]): string {
	let ignoredTag: string | null = null;
	return tokens.map((token) => {
		if (token.type === 'html') {
			if (token.block) return ' ';
			const tag = /^<\s*(\/?)\s*(script|style)\b/i.exec(token.raw);
			if (tag) {
				const name = tag[2].toLowerCase();
				if (tag[1] && ignoredTag === name) ignoredTag = null;
				else if (!tag[1] && !ignoredTag && !token.raw.endsWith('/>')) ignoredTag = name;
			}
			return !ignoredTag && /^<\s*br\b/i.test(token.raw) ? ' ' : '';
		}
		if (ignoredTag) return '';
		switch (token.type) {
			case 'def':
				return ' ';
			case 'space':
			case 'br':
			case 'hr':
				return ' ';
			case 'list':
				return ` ${(token.items as Tokens.ListItem[]).map((item) => tokenText(item.tokens)).join(' ')} `;
			case 'table': {
				const cells = [...(token.header as Tokens.TableCell[]), ...(token.rows as Tokens.TableCell[][]).flat()];
				return ` ${cells.map((cell) => tokenText(cell.tokens)).join(' ')} `;
			}
		}
		const nested = 'tokens' in token && Array.isArray(token.tokens) ? tokenText(token.tokens) : null;
		const text = nested ?? ('text' in token && typeof token.text === 'string'
			? token.type === 'text' ? decodeHTML(token.text) : token.text
			: '');
		return ['paragraph', 'heading', 'blockquote', 'code'].includes(token.type) ? ` ${text} ` : text;
	}).join('');
}

/** Extract text from Markdown tokens without interpreting untrusted HTML. */
export function markdownExcerpt(markdown: string): string {
	return excerpt(tokenText(marked.lexer(markdown)));
}

export function filterEntries(entries: readonly AnnotationEntry[], query: string): AnnotationEntry[] {
	const search = foldText(query.trim());
	if (!search) return [...entries];
	return entries.filter((entry) => {
		const content = entry.kind === 'mark'
			? `${entry.row.text}\n${entry.notes.map((note) => `${note.body_md}\n${tokenText(marked.lexer(note.body_md))}`).join('\n')}`
			: entry.row.kind === 'text' ? entry.row.data.text : entry.excerpt;
		return foldText(content).includes(search);
	});
}

export function formatStamp(iso: string, now: Date, locale: string): string {
	const date = new Date(iso);
	if (!Number.isFinite(date.getTime())) return iso;
	if (date.getFullYear() !== now.getFullYear()) {
		return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
	}
	const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
	const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
	return `${day} ${time}`;
}

export function buildAnnotationList(input: {
	highlights: readonly Highlight[];
	notes: readonly Note[];
	pageAnnotations: readonly PageAnnotation[];
	fileId: number;
	locatorType?: 'pdf' | 'cfi';
}) {
	const entries: AnnotationEntry[] = [];
	const otherFile: AnnotationEntry[] = [];
	function add(entry: AnnotationEntry) {
		const compatible = input.locatorType === 'cfi'
			? isCfiLocator(entry.row.locator)
			: entry.page !== null;
		(entry.row.book_file_id === input.fileId && compatible ? entries : otherFile).push(entry);
	}
	for (const row of buildMarks(input.highlights, input.notes)) {
		const locator = isPdfLocator(row.locator) ? row.locator : null;
		const rect = locator?.rects?.[0];
		add({
			id: row.id, kind: 'mark', row, page: locator?.page ?? null, y: rect?.y ?? 0, rect,
			createdAt: row.created_at, updatedAt: row.updated_at, excerpt: excerpt(row.text),
			notes: row.notes, commentExcerpt: row.notes[0]
				? input.locatorType === 'cfi' ? excerpt(row.notes[0].body_md) : markdownExcerpt(row.notes[0].body_md)
				: '',
			swatch: { kind: 'mark', style: row.style ?? 'highlight', hex: resolveMarkColor(row.color) }
		});
	}
	for (const row of input.pageAnnotations) {
		if (row.deleted_at) continue;
		add({
			id: row.id, kind: row.kind, row, page: row.locator.type === 'pdf' ? row.locator.page : null, y: row.locator.rect.y,
			rect: row.locator.rect, createdAt: row.created_at, updatedAt: row.updated_at,
			excerpt: row.kind === 'text' ? excerpt(row.data.text)
				: row.kind === 'ink' ? m['pv10.drawing']() : m['pv10.image'](),
			commentExcerpt: '', notes: [], swatch: { kind: row.kind }
		});
	}
	const compare = (a: AnnotationEntry, b: AnnotationEntry) =>
		(a.page ?? Infinity) - (b.page ?? Infinity) || a.y - b.y ||
		a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
	entries.sort(input.locatorType === 'cfi'
		? (a, b) => a.row.position - b.row.position || compare(a, b)
		: compare);
	otherFile.sort(compare);
	return {
		entries, otherFile,
		count: entries.length
	};
}
