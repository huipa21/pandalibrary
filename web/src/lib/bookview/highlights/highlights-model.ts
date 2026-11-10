import type { BookFile } from '#lib/catalog/types.js';
import { HIGHLIGHT_HEX, isMarkColor, MARK_PRESETS, resolveMarkColor } from '#lib/reader/annotations.js';
import type { Highlight, HighlightStyle, Note } from '#lib/reader/types.js';

export type Mark = Highlight & { notes: Note[] };
export type MarkSort = 'reading' | 'newest' | 'oldest';
export const MARK_SORTS: readonly MarkSort[] = ['reading', 'newest', 'oldest'];
export const UNKNOWN_FORMAT = 'unknown';
export const DEFAULT_UNTITLED = 'Untitled section';

export interface MarkFilter {
	query: string;
	colors: ReadonlySet<string>;
	notesOnly: boolean;
	styles?: ReadonlySet<HighlightStyle>;
}

export interface ChapterGroup {
	chapter: string;
	untitled: boolean;
	marks: Mark[];
}

export interface ColorCount {
	color: string;
	count: number;
}

export interface FormatCount {
	format: string;
	count: number;
}

export interface WeekCount {
	/** Local calendar date (YYYY-MM-DD) of the ISO week's Monday. */
	start: string;
	count: number;
}

export interface MarkStats {
	total: number;
	chapters: number;
	byColor: ColorCount[];
	byFormat: FormatCount[];
	weeks: WeekCount[];
	busiestWeek: WeekCount | null;
}

export function parseMarkSort(value: string | null): MarkSort {
	return MARK_SORTS.find((sort) => sort === value) ?? 'reading';
}

/** Live highlights with their live attached notes; book-level notes are excluded. */
export function buildMarks(highlights: readonly Highlight[], notes: readonly Note[]): Mark[] {
	const attached = new Map<string, Note[]>();
	for (const note of notes) {
		if (note.deleted_at || note.highlight_id === null) continue;
		const list = attached.get(note.highlight_id) ?? [];
		list.push(note);
		attached.set(note.highlight_id, list);
	}
	return highlights
		.filter((highlight) => !highlight.deleted_at)
		.map((highlight) => ({
			...highlight,
			style: highlight.style ?? 'highlight',
			notes: (attached.get(highlight.id) ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at))
		}));
}

/** Lower-cases text and removes diacritics so "Élan" matches "elan". */
export function foldText(text: string): string {
	return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function filterMarks(marks: readonly Mark[], filter: MarkFilter): Mark[] {
	const query = foldText(filter.query.trim());
	return marks.filter((mark) => {
		if (filter.colors.size > 0 && !filter.colors.has(colorKey(mark.color))) return false;
		if (filter.notesOnly && mark.notes.length === 0) return false;
		if (filter.styles?.size && !filter.styles.has(mark.style ?? 'highlight')) return false;
		if (!query) return true;
		return foldText(mark.text).includes(query) || mark.notes.some((note) => foldText(note.body_md).includes(query));
	});
}

function byReading(a: Mark, b: Mark): number {
	return a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

export function sortMarks(marks: readonly Mark[], sort: MarkSort): Mark[] {
	const sorted = marks.slice();
	if (sort === 'reading') return sorted.sort(byReading);
	const direction = sort === 'newest' ? -1 : 1;
	return sorted.sort((a, b) => direction * (a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
}

/** Stable identity of a chapter group, shared by the list and the sidebar. */
export function chapterKey(group: Pick<ChapterGroup, 'chapter' | 'untitled'>): string {
	return group.untitled ? 'untitled' : `c:${group.chapter}`;
}

/** Groups by chapter in order of first appearance; a missing chapter becomes the untitled section. */
export function groupByChapter(marks: readonly Mark[], untitled = DEFAULT_UNTITLED): ChapterGroup[] {
	const groups = new Map<string, ChapterGroup>();
	for (const mark of marks) {
		const name = mark.chapter?.trim() ?? '';
		const key = name ? `c:${name}` : 'untitled';
		let group = groups.get(key);
		if (!group) {
			group = { chapter: name || untitled, untitled: !name, marks: [] };
			groups.set(key, group);
		}
		group.marks.push(mark);
	}
	return [...groups.values()];
}

export function colorKey(color: string): string {
	if (!isMarkColor(color)) return color;
	const hex = resolveMarkColor(color);
	return MARK_PRESETS.find((preset) => resolveMarkColor(preset.value) === hex)?.value ?? hex;
}

function colorRank(color: string): number {
	const key = colorKey(color);
	const index = MARK_PRESETS.findIndex((preset) => preset.value === key);
	if (index >= 0) return index;
	if (key.toLowerCase() === 'red') return 2;
	return MARK_PRESETS.length + (isMarkColor(key) ? 0 : 1);
}

export function sortColorOptions(options: readonly ColorCount[]): ColorCount[] {
	return options.slice().sort((a, b) =>
		colorRank(a.color) - colorRank(b.color) ||
		a.color.toLowerCase().localeCompare(b.color.toLowerCase()) ||
		a.color.localeCompare(b.color)
	);
}

/** Counts per colour, most frequent first, ties in palette order. */
export function colorCounts(marks: readonly Mark[]): ColorCount[] {
	const counts = new Map<string, number>();
	for (const mark of marks) {
		const color = colorKey(mark.color);
		counts.set(color, (counts.get(color) ?? 0) + 1);
	}
	return [...counts]
		.map(([color, count]) => ({ color, count }))
		.sort((a, b) => b.count - a.count || colorRank(a.color) - colorRank(b.color) || a.color.localeCompare(b.color));
}

function dayKey(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of the Monday that starts the ISO week containing `date`. */
export function isoWeekStart(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
}

/** Parses a `WeekCount.start` key back into a local date. */
export function weekStartDate(start: string): Date {
	const [year, month, day] = start.split('-').map(Number);
	return new Date(year, month - 1, day);
}

const WEEK_MS = 7 * 86_400_000;
export const WEEK_COUNT = 52;

export function markStats(
	marks: readonly Mark[],
	now: Date = new Date(),
	files: readonly Pick<BookFile, 'id' | 'format'>[] = []
): MarkStats {
	const formats = new Map(files.map((file) => [file.id, file.format.toLowerCase()]));
	const formatCounts = new Map<string, number>();
	for (const mark of marks) {
		const format = (mark.book_file_id !== null && formats.get(mark.book_file_id)) || UNKNOWN_FORMAT;
		formatCounts.set(format, (formatCounts.get(format) ?? 0) + 1);
	}
	const byFormat = [...formatCounts]
		.map(([format, count]) => ({ format, count }))
		.sort((a, b) => b.count - a.count || a.format.localeCompare(b.format));

	const current = isoWeekStart(now);
	const weeks: WeekCount[] = Array.from({ length: WEEK_COUNT }, (_, index) => {
		const start = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 7 * (WEEK_COUNT - 1 - index));
		return { start: dayKey(start), count: 0 };
	});
	for (const mark of marks) {
		const created = new Date(mark.created_at);
		if (!Number.isFinite(created.getTime())) continue;
		// Rounding absorbs the hour gained or lost when a DST change falls between the weeks.
		const ago = Math.round((current.getTime() - isoWeekStart(created).getTime()) / WEEK_MS);
		if (ago >= 0 && ago < WEEK_COUNT) weeks[WEEK_COUNT - 1 - ago].count += 1;
	}
	let busiestWeek: WeekCount | null = null;
	for (const week of weeks) {
		if (week.count > 0 && (!busiestWeek || week.count > busiestWeek.count)) busiestWeek = week;
	}

	return {
		total: marks.length,
		chapters: groupByChapter(marks).length,
		byColor: colorCounts(marks),
		byFormat,
		weeks,
		busiestWeek
	};
}

export interface ColorTone {
	/** Solid swatch for the left bar, dots and stacked bars. */
	bar: string;
	/** Soft background for chips. */
	soft: string;
	text: string;
	/** For SVG fills. */
	hex: string;
}

const TONES: Record<string, ColorTone> = {
	yellow: { bar: 'bg-yellow-400', soft: 'bg-yellow-50', text: 'text-yellow-900', hex: HIGHLIGHT_HEX.yellow },
	blue: { bar: 'bg-sky-500', soft: 'bg-sky-50', text: 'text-sky-900', hex: HIGHLIGHT_HEX.blue },
	red: { bar: 'bg-red-500', soft: 'bg-red-50', text: 'text-red-900', hex: '#ef4444' },
	orange: { bar: 'bg-orange-400', soft: 'bg-orange-50', text: 'text-orange-900', hex: HIGHLIGHT_HEX.orange },
	green: { bar: 'bg-emerald-500', soft: 'bg-emerald-50', text: 'text-emerald-900', hex: HIGHLIGHT_HEX.green },
	purple: { bar: 'bg-violet-500', soft: 'bg-violet-50', text: 'text-violet-900', hex: HIGHLIGHT_HEX.purple },
	// The reader also stores pink highlights.
	pink: { bar: 'bg-pink-400', soft: 'bg-pink-50', text: 'text-pink-900', hex: HIGHLIGHT_HEX.pink }
};
const SLATE: ColorTone = { bar: 'bg-slate-400', soft: 'bg-slate-100', text: 'text-slate-800', hex: '#94a3b8' };

export function colorTone(color: string): ColorTone {
	if (color.startsWith('#') && isMarkColor(color)) return { ...SLATE, bar: '', hex: resolveMarkColor(color) };
	const tone = Object.hasOwn(TONES, color.toLowerCase()) ? TONES[color.toLowerCase()] : SLATE;
	return { ...tone, hex: resolveMarkColor(color) };
}

export interface TextSegment {
	text: string;
	match: boolean;
}

/** Splits text into matching and non-matching runs using the same folding as `filterMarks`. */
export function matchSegments(text: string, query: string): TextSegment[] {
	const needle = foldText(query.trim());
	if (!text) return [];
	if (!needle) return [{ text, match: false }];
	let folded = '';
	// starts[i] is the index in `text` of the character that produced folded[i].
	const starts: number[] = [];
	for (let index = 0; index < text.length;) {
		const char = String.fromCodePoint(text.codePointAt(index) ?? 0);
		const piece = foldText(char);
		for (let i = 0; i < piece.length; i += 1) starts.push(index);
		folded += piece;
		index += char.length;
	}
	const segments: TextSegment[] = [];
	let cursor = 0;
	let from = 0;
	for (;;) {
		const found = folded.indexOf(needle, from);
		if (found < 0) break;
		const start = starts[found];
		const endFolded = found + needle.length;
		const end = endFolded < starts.length ? starts[endFolded] : text.length;
		if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
		if (end > Math.max(start, cursor)) segments.push({ text: text.slice(Math.max(start, cursor), end), match: true });
		cursor = Math.max(cursor, end);
		from = endFolded;
	}
	if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
	return segments;
}
