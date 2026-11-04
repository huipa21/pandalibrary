import type { Book } from '#lib/catalog/types.js';
import {
	MERGE_FIELDS,
	type Candidate,
	type CandidateRef,
	type MergeField,
	type ProviderResult,
	type Selections
} from './types.js';

export type RoleLabel = (role: string) => string;

const identity: RoleLabel = (role) => role;

export function candidateKey(ref: CandidateRef): string {
	return `${ref.provider}\u0000${ref.reference}`;
}

export function sameCandidate(a: CandidateRef | undefined, b: CandidateRef | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.reference === b.reference;
}

function text(value: string | null | undefined): string[] {
	return value === null || value === undefined || value === '' ? [] : [value];
}

function seriesText(series: { name: string; index: number | null } | null): string[] {
	if (!series) return [];
	return [series.index === null ? series.name : `${series.name} #${series.index}`];
}

/** Display values for the current catalog book; an empty array means no value. */
export function currentValues(book: Book, field: MergeField, roleLabel: RoleLabel = identity): string[] {
	switch (field) {
		case 'title': return text(book.title);
		case 'subtitle': return text(book.subtitle);
		case 'description': return text(book.description);
		case 'language': return text(book.language);
		case 'publisher': return text(book.publisher);
		case 'published_date': return text(book.published_date);
		case 'page_count': return book.page_count === null ? [] : [String(book.page_count)];
		case 'series': return seriesText(book.series);
		case 'authors':
			return [...book.authors]
				.sort((a, b) => a.position - b.position)
				.map((author) => `${author.name} (${roleLabel(author.role)})`);
		case 'tags': return book.tags.map((tag) => tag.name);
		case 'identifiers': return book.identifiers.map((id) => `${id.scheme}: ${id.value}`);
		case 'cover': return book.cover_url ? [book.cover_source ?? ''] : [];
	}
}

/** Display values for a cached candidate, preserving provider order for arrays. */
export function candidateValues(candidate: Candidate, field: MergeField, roleLabel: RoleLabel = identity): string[] {
	switch (field) {
		case 'title': return text(candidate.title);
		case 'subtitle': return text(candidate.subtitle);
		case 'description': return text(candidate.description);
		case 'language': return text(candidate.language);
		case 'publisher': return text(candidate.publisher);
		case 'published_date': return text(candidate.published_date);
		case 'page_count': return candidate.page_count === null || candidate.page_count === undefined ? [] : [String(candidate.page_count)];
		case 'series': return seriesText(candidate.series);
		case 'authors': return candidate.authors.map((person) => `${person.name} (${roleLabel(person.role)})`);
		case 'tags': return [...candidate.tags];
		case 'identifiers': return candidate.identifiers.map((id) => `${id.scheme}: ${id.value}`);
		case 'cover': return candidate.cover_url ? [candidate.provider] : [];
	}
}

/**
 * Whether a candidate can be chosen for a field. A cover needs a cached cover and the
 * title cannot be cleared; other empty values are offered as explicit clears.
 */
export function candidateOffers(candidate: Candidate, field: MergeField): boolean {
	if (field === 'cover') return candidate.cover_url !== null && candidate.cover_url !== undefined && candidate.cover_url !== '';
	if (field === 'title') return candidate.title.trim() !== '';
	return true;
}

/** True when choosing this candidate for the field would clear the current value. */
export function candidateClears(candidate: Candidate, field: MergeField): boolean {
	return field !== 'cover' && field !== 'title' && candidateValues(candidate, field).length === 0;
}

export function matchesCurrent(book: Book, candidate: Candidate, field: MergeField): boolean {
	if (field === 'cover') return false;
	const current = currentValues(book, field);
	const next = candidateValues(candidate, field);
	if (field === 'tags') {
		const normalize = (values: string[]) => values.map((value) => value.toLowerCase()).sort();
		return JSON.stringify(normalize(current)) === JSON.stringify(normalize(next));
	}
	return JSON.stringify(current) === JSON.stringify(next);
}

export function allCandidates(providers: ProviderResult[]): Candidate[] {
	return providers.flatMap((provider) => provider.candidates);
}

export function findCandidate(providers: ProviderResult[], ref: CandidateRef): Candidate | undefined {
	return allCandidates(providers).find((candidate) => sameCandidate(candidate, ref));
}

export function selectField(selections: Selections, field: MergeField, ref: CandidateRef | null): Selections {
	const next: Selections = { ...selections };
	if (ref === null) delete next[field];
	else next[field] = { provider: ref.provider, reference: ref.reference };
	return next;
}

/** Selects every field for which the candidate has a value; it never selects a clear. */
export function selectCandidateValues(selections: Selections, candidate: Candidate): Selections {
	let next = selections;
	for (const field of MERGE_FIELDS) {
		if (candidateOffers(candidate, field) && !candidateClears(candidate, field)) {
			next = selectField(next, field, candidate);
		}
	}
	return next;
}

/** Drops selections that no longer refer to a candidate in the current lookup. */
export function pruneSelections(selections: Selections, providers: ProviderResult[]): Selections {
	const next: Selections = {};
	for (const field of MERGE_FIELDS) {
		const ref = selections[field];
		const candidate = ref ? findCandidate(providers, ref) : undefined;
		if (ref && candidate && candidateOffers(candidate, field)) next[field] = ref;
	}
	return next;
}

export function selectionCount(selections: Selections): number {
	return MERGE_FIELDS.filter((field) => selections[field] !== undefined).length;
}

export function candidateCount(providers: ProviderResult[]): number {
	return allCandidates(providers).length;
}
