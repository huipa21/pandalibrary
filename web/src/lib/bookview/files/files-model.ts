import type { Book, BookFile } from '#lib/catalog/types.js';
import { readerFormat, type Progress } from '#lib/reader/types.js';
import { FORMAT_ORDER, sortedFormats } from '../cover.js';

export type ReaderGroup = 'ebook' | 'document' | 'comic' | 'other';
export type FileSort = 'format' | 'name' | 'size' | 'added';

export interface FileItem extends BookFile {
	readonly progress: number | null;
	readonly readable: boolean;
	readonly saved: boolean;
}

export interface FileGroup {
	readonly key: ReaderGroup;
	readonly files: FileItem[];
	readonly count: number;
	readonly bytes: number;
}

export interface FilesModel {
	readonly groups: FileGroup[];
	readonly totalBytes: number;
	readonly formats: { format: string; count: number }[];
	readonly primaryFileId: number | null;
}

const GROUP_ORDER: readonly ReaderGroup[] = ['ebook', 'document', 'comic', 'other'];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function normalizedFormat(format: string): string {
	return format.trim().toLowerCase();
}

function legacyFileName(book: Book, file: BookFile): string {
	const title = book.title.trim().replace(/[\/\\\p{Cc}]/gu, '_') || 'book';
	const format = normalizedFormat(file.format).replace(/[\/\\\p{Cc}]/gu, '_') || 'file';
	return `${title}.${format}`;
}

export function readerGroup(format: string): ReaderGroup {
	switch (normalizedFormat(format)) {
		case 'epub':
		case 'mobi':
		case 'azw3':
		case 'fb2':
		case 'fbz':
			return 'ebook';
		case 'pdf': return 'document';
		case 'cbz': return 'comic';
		default: return 'other';
	}
}

function compareNames(left: FileItem, right: FileItem): number {
	return collator.compare(left.original_filename, right.original_filename) || left.id - right.id;
}

function compareFormats(left: FileItem, right: FileItem): number {
	const leftFormat = normalizedFormat(left.format);
	const rightFormat = normalizedFormat(right.format);
	const order: readonly string[] = FORMAT_ORDER;
	const leftRank = order.indexOf(leftFormat);
	const rightRank = order.indexOf(rightFormat);
	if (leftRank !== rightRank) {
		if (leftRank === -1) return 1;
		if (rightRank === -1) return -1;
		return leftRank - rightRank;
	}
	return collator.compare(leftFormat, rightFormat) || compareNames(left, right);
}

export function sortFiles(files: readonly FileItem[], sort: FileSort): FileItem[] {
	return [...files].sort((left, right) => {
		switch (sort) {
			case 'name': return compareNames(left, right);
			case 'size': return right.size_bytes - left.size_bytes || compareNames(left, right);
			case 'added': {
				const leftTime = Date.parse(left.created_at);
				const rightTime = Date.parse(right.created_at);
				if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
					return rightTime - leftTime || compareNames(left, right);
				}
				if (Number.isFinite(leftTime)) return -1;
				if (Number.isFinite(rightTime)) return 1;
				return compareNames(left, right);
			}
			case 'format': return compareFormats(left, right);
		}
	});
}

export function splitFileName(name: string): { stem: string; extension: string } {
	const dot = name.lastIndexOf('.');
	return dot > 0 && dot < name.length - 1
		? { stem: name.slice(0, dot), extension: name.slice(dot) }
		: { stem: name, extension: '' };
}

export function buildFilesModel(
	book: Book,
	progress: Progress | null,
	savedFileIds: readonly number[]
): FilesModel {
	const saved = new Set(savedFileIds);
	const files: FileItem[] = book.files.map((file) => ({
		...file,
		// Books downloaded before BV1 do not have these two fields.
		original_filename: typeof file.original_filename === 'string' && file.original_filename.trim()
			? file.original_filename
			: legacyFileName(book, file),
		created_at: typeof file.created_at === 'string' ? file.created_at : '',
		progress: progress?.book_file_id === file.id ? progress.percentage : null,
		readable: readerFormat(file.format) !== null,
		saved: saved.has(file.id)
	}));
	const groups = GROUP_ORDER.flatMap((key) => {
		const groupFiles = sortFiles(files.filter((file) => readerGroup(file.format) === key), 'format');
		return groupFiles.length ? [{
			key,
			files: groupFiles,
			count: groupFiles.length,
			bytes: groupFiles.reduce((total, file) => total + file.size_bytes, 0)
		}] : [];
	});
	const primary = files.find((file) => file.id === progress?.book_file_id) ?? sortFiles(files, 'format')[0];
	return {
		groups,
		totalBytes: files.reduce((total, file) => total + file.size_bytes, 0),
		formats: sortedFormats(files).map((format) => ({
			format,
			count: files.filter((file) => normalizedFormat(file.format) === format).length
		})),
		primaryFileId: primary?.id ?? null
	};
}
