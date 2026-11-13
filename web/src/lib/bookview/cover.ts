import type { BookFile } from '#lib/catalog/types.js';

export const FORMAT_ORDER = ['epub', 'pdf', 'cbz', 'azw3', 'mobi', 'fb2', 'fbz'] as const;

const CLOTH = [
	{ name: 'navy', board: '#1f2f5c', spine: '#142044', frame: '#d9b768', plate: '#f3eedf', plateRule: '#b7a88a', ink: '#18223d', author: '#d9b768' },
	{ name: 'forest', board: '#24462a', spine: '#18321d', frame: '#d9b768', plate: '#f3eedf', plateRule: '#b7a88a', ink: '#18351e', author: '#d9b768' },
	{ name: 'ochre', board: '#cbb153', spine: '#6e540f', frame: '#3b2a17', plate: '#f3eedf', plateRule: '#b7a88a', ink: '#3e2f09', author: '#120c06' },
	{ name: 'khaki', board: '#c6b18f', spine: '#55452f', frame: '#3b2a17', plate: '#f3eedf', plateRule: '#b7a88a', ink: '#332719', author: '#120c06' },
	{ name: 'rust', board: '#8b3a17', spine: '#612810', frame: '#d9b768', plate: '#f3eedf', plateRule: '#b7a88a', ink: '#4c1d0a', author: '#d9b768' },
	{ name: 'taupe', board: '#c7b495', spine: '#5c4c36', frame: '#3b2a17', plate: '#f3eedf', plateRule: '#b7a88a', ink: '#3d3021', author: '#120c06' },
	{ name: 'burgundy', board: '#5e1f2a', spine: '#40151d', frame: '#d9b768', plate: '#f3eedf', plateRule: '#b7a88a', ink: '#3d131a', author: '#d9b768' },
	{ name: 'slate-teal', board: '#24494d', spine: '#193335', frame: '#d9b768', plate: '#f3eedf', plateRule: '#b7a88a', ink: '#163035', author: '#d9b768' }
] as const;

export function coverCloth(seed: number): (typeof CLOTH)[number] {
	let hash = seed | 0;
	hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
	hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
	hash ^= hash >>> 16;
	return CLOTH[(hash >>> 0) % CLOTH.length];
}

function splitGraphemes(value: string): string[] {
	return typeof Intl.Segmenter === 'function'
		? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), (part) => part.segment)
		: Array.from(value);
}

export function titleScale(title: string): 'xl' | 'lg' | 'md' | 'sm' {
	const length = splitGraphemes(title).length;
	if (length <= 6) return 'xl';
	if (length <= 14) return 'lg';
	if (length <= 32) return 'md';
	return 'sm';
}

export function truncateTitle(title: string, max = 80): string {
	if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('Title limit must be a non-negative integer.');
	const graphemes = splitGraphemes(title);
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

export function defaultFile<T extends Pick<BookFile, 'is_default'>>(files: readonly T[]): T | null {
	return files.find((file) => file.is_default === true) ?? null;
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
