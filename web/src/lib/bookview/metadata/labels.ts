import { CONTENT_RATINGS, type Book } from '#lib/catalog/types.js';
import * as m from '#lib/paraglide/messages.js';
import type { MetadataDraft } from '#lib/metadata/editor.js';
import { ratingText } from '#lib/metadata/merge.js';
import type { MergeField } from '#lib/metadata/types.js';

export const fieldLabels: Record<MergeField, () => string> = {
	title: m['metadata.field.title'],
	subtitle: m['metadata.field.subtitle'],
	authors: m['metadata.field.authors'],
	description: m['metadata.field.description'],
	language: m['metadata.field.language'],
	publisher: m['metadata.field.publisher'],
	published_date: m['metadata.field.published_date'],
	page_count: m['metadata.field.page_count'],
	series: m['metadata.field.series'],
	tags: m['metadata.field.tags'],
	genres: m['metadata.field.genres'],
	moods: m['metadata.field.moods'],
	age_rating: m['metadata.field.age_rating'],
	content_rating: m['metadata.field.content_rating'],
	ratings: m['metadata.field.ratings'],
	identifiers: m['metadata.field.identifiers'],
	cover: m['metadata.field.cover']
};

export const ROLES = ['author', 'translator', 'editor', 'illustrator'] as const;

export function roleLabel(role: string): string {
	switch (role) {
		case 'author': return m['catalog.book.role.author']();
		case 'translator': return m['catalog.book.role.translator']();
		case 'editor': return m['catalog.book.role.editor']();
		case 'illustrator': return m['catalog.book.role.illustrator']();
		default: return role;
	}
}

export function contentRatingLabel(value: string): string {
	switch (value) {
		case 'everyone': return m['metadata.content.everyone']();
		case 'teen': return m['metadata.content.teen']();
		case 'mature': return m['metadata.content.mature']();
		case 'adult': return m['metadata.content.adult']();
		default: return value;
	}
}

export function ageRatingLabel(value: string | number): string {
	return m['metadata.age.value']({ age: String(value) });
}

/** Localizes display values produced by `candidateValues`/`currentValues` where needed. */
export function displayValues(field: MergeField, values: string[]): string[] {
	if (field === 'content_rating') return values.map(contentRatingLabel);
	if (field === 'age_rating') return values.map(ageRatingLabel);
	return values;
}

export { CONTENT_RATINGS };

function present(value: string): string[] {
	return value.trim() === '' ? [] : [value];
}

/** Display values for the draft, matching the shape of `candidateValues` for comparison rows. */
export function draftValues(draft: MetadataDraft, field: MergeField): string[] {
	switch (field) {
		case 'title':
		case 'subtitle':
		case 'description':
		case 'language':
		case 'publisher':
		case 'published_date':
		case 'page_count':
			return present(draft[field]);
		case 'age_rating': return present(draft.age_rating).map(ageRatingLabel);
		case 'content_rating': return present(draft.content_rating).map(contentRatingLabel);
		case 'series': {
			if (draft.series.name.trim() === '') return [];
			let value = draft.series.index.trim() ? `${draft.series.name} #${draft.series.index.trim()}` : draft.series.name;
			if (draft.series.total.trim()) value += ` / ${draft.series.total.trim()}`;
			return [value];
		}
		case 'authors': return draft.authors.map((person) => `${person.name} (${roleLabel(person.role)})`);
		case 'tags':
		case 'genres':
		case 'moods':
			return [...draft[field]];
		case 'ratings': return draft.ratings.flatMap((row) => ratingText(row) ?? []);
		case 'identifiers': return draft.identifiers.map((id) => `${id.scheme}: ${id.value}`);
		case 'cover': return [];
	}
}

export function sourceLabel(source: string): string {
	return source === 'manual' ? m['metadata.source.manual']() : source;
}

/** The saved provenance of a field, if the server recorded one. */
export function fieldSource(book: Book, field: MergeField) {
	return book.field_sources?.find((entry) => entry.field === field) ?? null;
}

export function providerErrorCode(code: string): string {
	return /^[a-z0-9_-]{1,64}$/i.test(code) ? code : 'unknown';
}
