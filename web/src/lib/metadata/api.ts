import { ApiError, api, type JsonValue, type ProblemDetails } from '#lib/api/client.js';
import type { Book } from '#lib/catalog/types.js';
import type { MetadataPatch } from './editor.js';
import type {
	ApplyResponse,
	Candidate,
	CandidateRef,
	LookupQuery,
	LookupResponse,
	ProviderResult,
	Selections
} from './types.js';

export class InvalidMetadataResponseError extends Error {
	constructor() {
		super('The metadata service returned an invalid response.');
		this.name = 'InvalidMetadataResponseError';
	}
}

function array<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function nullable<T>(value: T | null | undefined): T | null {
	return value === undefined ? null : value;
}

function normalizeCandidate(provider: string, raw: unknown): Candidate {
	if (typeof raw !== 'object' || raw === null) throw new InvalidMetadataResponseError();
	const candidate = raw as Candidate;
	if (typeof candidate.reference !== 'string' || candidate.reference === '') {
		throw new InvalidMetadataResponseError();
	}
	return {
		...candidate,
		provider: typeof candidate.provider === 'string' ? candidate.provider : provider,
		authors: array(candidate.authors),
		tags: array(candidate.tags),
		genres: array(candidate.genres),
		moods: array(candidate.moods),
		age_rating: nullable(candidate.age_rating),
		content_rating: nullable(candidate.content_rating),
		rating: nullable(candidate.rating),
		rating_count: nullable(candidate.rating_count),
		series: candidate.series ? { ...candidate.series, index: nullable(candidate.series.index), total: nullable(candidate.series.total) } : null,
		identifiers: array(candidate.identifiers)
	};
}

/** Validates the M1 lookup envelope; one failed provider never discards others. */
export function normalizeLookup(raw: unknown): LookupResponse {
	if (typeof raw !== 'object' || raw === null) throw new InvalidMetadataResponseError();
	const response = raw as LookupResponse;
	if (typeof response.request_key !== 'string' || response.request_key === '' || !Array.isArray(response.providers)) {
		throw new InvalidMetadataResponseError();
	}
	const providers: ProviderResult[] = response.providers.map((item) => {
		if (typeof item?.provider !== 'string') throw new InvalidMetadataResponseError();
		const error = item.error && typeof item.error === 'object'
			? { code: String(item.error.code ?? ''), message: String(item.error.message ?? '') }
			: null;
		return {
			provider: item.provider,
			candidates: array<unknown>(item.candidates).map((candidate) => normalizeCandidate(item.provider, candidate)),
			error
		};
	});
	return { request_key: response.request_key, query: response.query ?? {}, providers };
}

/** The JSON body for a custom search: trimmed, without empty values. */
export function buildLookupBody(query: LookupQuery): { [key: string]: JsonValue } {
	const body: { [key: string]: JsonValue } = {};
	for (const key of ['isbn', 'title', 'author', 'language'] as const) {
		const value = query[key]?.trim();
		if (value) body[key] = value;
	}
	const providers = [...new Set((query.providers ?? []).map((provider) => provider.trim()).filter(Boolean))];
	if (providers.length) body.providers = providers;
	return body;
}

/** Without a query the server searches every enabled provider using the catalog book. */
export async function lookupCandidates(bookId: number, query?: LookupQuery, signal?: AbortSignal): Promise<LookupResponse> {
	const response = await api.request<unknown>(`/books/${bookId}/metadata/candidates`, {
		method: 'POST',
		signal,
		...(query ? { body: buildLookupBody(query) } : {})
	});
	return normalizeLookup(response);
}

export function buildApplyBody(requestKey: string, selections: Selections): { [key: string]: JsonValue } {
	const fields: { [key: string]: JsonValue } = {};
	for (const [field, ref] of Object.entries(selections)) {
		if (!ref) continue;
		fields[field] = { provider: ref.provider, reference: ref.reference };
	}
	return { request_key: requestKey, fields };
}

export async function applyMetadata(bookId: number, requestKey: string, selections: Selections): Promise<Book> {
	const body = buildApplyBody(requestKey, selections);
	if (Object.keys(body.fields as object).length === 0) throw new Error('No metadata fields were selected.');
	const response = await api.request<ApplyResponse>(`/books/${bookId}/metadata/apply`, { method: 'POST', body });
	if (!response?.book || response.book.id !== bookId) throw new InvalidMetadataResponseError();
	return response.book;
}

/** Save manual edits alone, or atomically alongside trusted provider selections. */
export async function saveMetadata(
	bookId: number,
	patch: MetadataPatch,
	requestKey: string | null,
	selections: Selections
): Promise<Book> {
	const selected = Object.values(selections).some((ref) => ref !== undefined);
	const hasPatch = Object.values(patch).some((value) => value !== undefined);
	if (!selected && !hasPatch) throw new Error('No metadata changes were made.');
	let response: ApplyResponse;
	if (selected) {
		if (!requestKey) throw new Error('A metadata request key is required for selected fields.');
		response = await api.request<ApplyResponse>(`/books/${bookId}/metadata/apply`, {
			method: 'POST',
			body: {
				...buildApplyBody(requestKey, selections),
				...(hasPatch ? { patch } : {})
			}
		});
	} else {
		response = await api.request<ApplyResponse>(`/books/${bookId}`, { method: 'PATCH', body: patch });
	}
	if (!response?.book || response.book.id !== bookId) throw new InvalidMetadataResponseError();
	return response.book;
}

async function problemFrom(response: Response): Promise<ApiError> {
	const body = await response.text();
	let problem: ProblemDetails | undefined;
	if (response.headers.get('content-type')?.toLowerCase().startsWith('application/problem+json')) {
		try {
			const parsed: unknown = JSON.parse(body);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) problem = parsed as ProblemDetails;
		} catch {
			problem = undefined;
		}
	}
	return new ApiError(response.status, response.statusText, body, problem);
}

/** Fetches a normalized JPEG preview through the server; candidate URLs are never fetched directly. */
export async function fetchCoverPreview(
	bookId: number,
	requestKey: string,
	ref: CandidateRef,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch
): Promise<Blob> {
	const response = await fetcher(`/api/v1/books/${bookId}/metadata/cover`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'image/jpeg' },
		body: JSON.stringify({ request_key: requestKey, provider: ref.provider, reference: ref.reference }),
		credentials: 'same-origin',
		cache: 'no-store',
		redirect: 'error',
		signal
	});
	if (!response.ok) throw await problemFrom(response);
	const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (type !== 'image/jpeg') throw new InvalidMetadataResponseError();
	const blob = await response.blob();
	return blob.type === 'image/jpeg' ? blob : new Blob([blob], { type: 'image/jpeg' });
}
