import type { Book } from '#lib/catalog/types.js';
import { InvalidTagsError, normalizeTags, trimSpace } from './tags.js';
import {
	MERGE_FIELDS,
	type Candidate,
	type CandidateIdentifier,
	type CandidatePerson,
	type MergeField,
	type Selections
} from './types.js';

export interface MetadataDraft {
	title: string;
	subtitle: string;
	description: string;
	language: string;
	publisher: string;
	published_date: string;
	page_count: string;
	authors: CandidatePerson[];
	series: { name: string; index: string };
	tags: string[];
	identifiers: CandidateIdentifier[];
}

/** Only editable metadata belongs here; covers are trusted candidate selections. */
export type MetadataPatch = {
	title?: string;
	subtitle?: string | null;
	description?: string | null;
	language?: string | null;
	publisher?: string | null;
	published_date?: string | null;
	page_count?: number | null;
	authors?: { name: string; role: string }[];
	series?: { name: string; index: number | null } | null;
	tags?: string[];
	identifiers?: { scheme: string; value: string }[];
};

export class InvalidMetadataDraftError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = 'InvalidMetadataDraftError';
	}
}

export function createDraft(book: Book): MetadataDraft {
	return {
		title: book.title,
		subtitle: book.subtitle ?? '',
		description: book.description ?? '',
		language: book.language ?? '',
		publisher: book.publisher ?? '',
		published_date: book.published_date ?? '',
		page_count: book.page_count === null ? '' : String(book.page_count),
		authors: [...book.authors].sort((a, b) => a.position - b.position)
			.map(({ name, role }) => ({ name, role })),
		series: { name: book.series?.name ?? '', index: book.series?.index == null ? '' : String(book.series.index) },
		tags: book.tags.map(({ name }) => name),
		identifiers: book.identifiers.map(({ scheme, value }) => ({ scheme, value }))
	};
}

export function copyCandidateField(draft: MetadataDraft, candidate: Candidate, field: MergeField): MetadataDraft {
	switch (field) {
		case 'cover': return draft;
		case 'page_count': return { ...draft, page_count: candidate.page_count == null ? '' : String(candidate.page_count) };
		case 'series':
			return { ...draft, series: {
				name: candidate.series?.name ?? '',
				index: candidate.series?.index == null ? '' : String(candidate.series.index)
			} };
		case 'authors': return { ...draft, authors: candidate.authors.map(({ name, role }) => ({ name, role })) };
		case 'identifiers':
			return { ...draft, identifiers: candidate.identifiers.map(({ scheme, value }) => ({ scheme, value })) };
		case 'tags': return { ...draft, tags: [...candidate.tags] };
		default: return { ...draft, [field]: candidate[field] ?? '' };
	}
}

export function restoreField(draft: MetadataDraft, book: Book, field: MergeField): MetadataDraft {
	if (field === 'cover') return draft;
	const original = createDraft(book);
	return { ...draft, [field]: original[field] };
}

function invalid(reason: string): never {
	throw new InvalidMetadataDraftError(reason);
}

function validText(value: string, limit: number, reason: string, controls = false): string {
	if (new TextEncoder().encode(value).length > limit || value.includes('\0') ||
		(controls && /[\u0000-\u001f\u007f-\u009f]/.test(value)) ||
		/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) {
		invalid(reason);
	}
	return value;
}

function name(value: string, reason: string): string {
	const result = trimSpace(value);
	if (!result) invalid(reason);
	return validText(result, 1024, reason, true);
}

function optionalText(value: string, limit: number, reason: string, preserveWhitespace = false): string | null {
	if (!trimSpace(value)) return null;
	return validText(preserveWhitespace ? value : trimSpace(value), limit, reason);
}

function pageCount(value: string): number | null {
	const input = trimSpace(value);
	if (!input) return null;
	const number = Number(input);
	if (!/^\d+$/.test(input) || !Number.isSafeInteger(number) || number < 1) invalid('page_count');
	return number;
}

function seriesValue(value: MetadataDraft['series']): MetadataPatch['series'] {
	const indexInput = trimSpace(value.index);
	if (!trimSpace(value.name)) {
		if (indexInput) invalid('series');
		return null;
	}
	const index = indexInput ? Number(indexInput) : null;
	if (index !== null && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(indexInput) ||
		!Number.isFinite(index) || index < 0)) invalid('series');
	return { name: name(value.name, 'series'), index };
}

function publishedDate(value: string): string | null {
	const result = optionalText(value, 10, 'published_date');
	if (result === null) return null;
	if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(result)) invalid('published_date');
	const [year, month = 1, day = 1] = result.split('-').map(Number);
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) invalid('published_date');
	return result;
}

function fold(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function authors(values: CandidatePerson[]): { name: string; role: string }[] {
	if (values.length > 1000) invalid('authors');
	const seen = new Set<string>();
	return values.map((person) => {
		const authorName = name(person.name, 'authors');
		if (!['author', 'translator', 'editor', 'illustrator'].includes(person.role)) invalid('authors');
		const key = `${fold(authorName)}\0${person.role}`;
		if (seen.has(key)) invalid('authors');
		seen.add(key);
		return { name: authorName, role: person.role };
	});
}

function identifiers(values: CandidateIdentifier[]): { scheme: string; value: string }[] {
	if (values.length > 1000) invalid('identifiers');
	const schemes = ['isbn13', 'isbn10', 'asin', 'doi', 'uuid', 'openlibrary', 'googlebooks', 'neodb', 'hardcover', 'douban'];
	const seen = new Set<string>();
	return values.map(({ scheme, value }) => {
		if (!schemes.includes(scheme)) invalid('identifiers');
		const normalized = trimSpace(value);
		if (!normalized) invalid('identifiers');
		validText(normalized, 2048, 'identifiers');
		const key = `${scheme}\0${normalized}`;
		if (seen.has(key)) invalid('identifiers');
		seen.add(key);
		return { scheme, value: normalized };
	});
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Validate only edited manual fields; cached references remain authoritative. */
export function buildManualPatch(book: Book, draft: MetadataDraft, selections: Selections): MetadataPatch {
	const original = createDraft(book);
	const patch: MetadataPatch = {};
	for (const field of MERGE_FIELDS) {
		if (field === 'cover' || selections[field] || same(draft[field], original[field])) continue;
		switch (field) {
			case 'title': {
				const value = name(draft.title, 'title');
				if (value !== book.title) patch.title = value;
				break;
			}
			case 'subtitle':
			case 'description':
			case 'language':
			case 'publisher': {
				const limit = field === 'description' ? 1 << 20 : field === 'language' ? 255 : 4096;
				const value = optionalText(draft[field], limit, field, field === 'description');
				if (value !== book[field]) patch[field] = value;
				break;
			}
			case 'published_date': {
				const value = publishedDate(draft.published_date);
				if (value !== book.published_date) patch.published_date = value;
				break;
			}
			case 'page_count': {
				const value = pageCount(draft.page_count);
				if (value !== book.page_count) patch.page_count = value;
				break;
			}
			case 'series': {
				const value = seriesValue(draft.series);
				const current = book.series ? { name: book.series.name, index: book.series.index } : null;
				if (!same(value, current)) patch.series = value;
				break;
			}
			case 'authors': {
				const value = authors(draft.authors);
				if (!same(value, original.authors)) patch.authors = value;
				break;
			}
			case 'tags': {
				const value = normalizeTags(draft.tags);
				if (!same(value, original.tags)) patch.tags = value;
				break;
			}
			case 'identifiers': {
				const value = identifiers(draft.identifiers);
				if (!same(value, original.identifiers)) patch.identifiers = value;
				break;
			}
		}
	}
	return patch;
}

export function metadataDirty(book: Book, draft: MetadataDraft, selections: Selections): boolean {
	if (MERGE_FIELDS.some((field) => selections[field] !== undefined)) return true;
	try {
		return Object.keys(buildManualPatch(book, draft, selections)).length > 0;
	} catch (error) {
		if (error instanceof InvalidMetadataDraftError || error instanceof InvalidTagsError) return true;
		throw error;
	}
}
