import type { BookFile } from '#lib/catalog/types.js';

export const FORMAT_ORDER = ['epub', 'pdf', 'cbz', 'azw3', 'mobi', 'fb2', 'fbz'] as const;

const TONES = [
	{ bg: 'bg-emerald-100', spine: 'bg-emerald-900/20', text: 'text-emerald-950', accent: 'bg-emerald-700' },
	{ bg: 'bg-teal-100', spine: 'bg-teal-900/20', text: 'text-teal-950', accent: 'bg-teal-700' },
	{ bg: 'bg-sky-100', spine: 'bg-sky-900/20', text: 'text-sky-950', accent: 'bg-sky-700' },
	{ bg: 'bg-indigo-100', spine: 'bg-indigo-900/20', text: 'text-indigo-950', accent: 'bg-indigo-700' },
	{ bg: 'bg-violet-100', spine: 'bg-violet-900/20', text: 'text-violet-950', accent: 'bg-violet-700' },
	{ bg: 'bg-rose-100', spine: 'bg-rose-900/20', text: 'text-rose-950', accent: 'bg-rose-700' },
	{ bg: 'bg-amber-100', spine: 'bg-amber-900/20', text: 'text-amber-950', accent: 'bg-amber-700' },
	{ bg: 'bg-slate-100', spine: 'bg-slate-900/20', text: 'text-slate-950', accent: 'bg-slate-700' }
] as const;

export function coverTone(seed: number): (typeof TONES)[number] {
	let hash = seed | 0;
	hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
	hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
	hash ^= hash >>> 16;
	return TONES[(hash >>> 0) % TONES.length];
}

export function truncateTitle(title: string, max = 80): string {
	if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('Title limit must be a non-negative integer.');
	const graphemes = typeof Intl.Segmenter === 'function'
		? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(title), (part) => part.segment)
		: Array.from(title);
	if (graphemes.length <= max) return title;
	return max === 0 ? '' : `${graphemes.slice(0, max - 1).join('')}…`;
}

export function sortedFormats(files: readonly Pick<BookFile, 'format'>[]): string[] {
	const formats = [...new Set(files.map((file) => file.format.trim().toLowerCase()).filter(Boolean))];
	return formats.sort((left, right) => {
		const leftIndex = FORMAT_ORDER.findIndex((format) => format === left);
		const rightIndex = FORMAT_ORDER.findIndex((format) => format === right);
		if (leftIndex === -1 && rightIndex === -1) return left < right ? -1 : left > right ? 1 : 0;
		if (leftIndex === -1) return 1;
		if (rightIndex === -1) return -1;
		return leftIndex - rightIndex;
	});
}

export function preferredFormat(files: readonly Pick<BookFile, 'format'>[]): string | null {
	return sortedFormats(files)[0] ?? null;
}

export function formatTone(format: string): string {
	switch (format.trim().toLowerCase()) {
		case 'epub': return 'bg-emerald-800 text-white';
		case 'pdf': return 'bg-red-800 text-white';
		case 'cbz': return 'bg-amber-200 text-amber-950';
		case 'azw3':
		case 'mobi': return 'bg-sky-800 text-white';
		case 'fb2':
		case 'fbz': return 'bg-violet-800 text-white';
		default: return 'bg-slate-700 text-white';
	}
}
