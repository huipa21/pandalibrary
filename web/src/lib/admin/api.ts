import { api, ApiError, type JsonValue, type ProblemDetails } from '#lib/api/client.js';
import { buildPagePath, MAX_PAGE_SIZE, type PageOptions } from '#lib/catalog/api.js';
import type {
	AccessEntry,
	HiddenEntry,
	ImportJob,
	Library,
	LibraryPatch,
	MaintenanceJob,
	MaintenanceRun,
	Page,
	ProviderPatch,
	ProviderSettings
} from './types.js';

type RequestOptions = PageOptions & { signal?: AbortSignal };

export function buildAdminLibrariesPath(options: PageOptions = {}): string {
	return buildPagePath('/admin/libraries', options);
}

export function buildAccessPath(libraryID: number, options: PageOptions = {}): string {
	return buildPagePath(`/admin/libraries/${libraryID}/access`, options);
}

export function buildHiddenBooksPath(userID: number, options: PageOptions = {}): string {
	return buildPagePath(`/admin/users/${userID}/hidden-books`, options);
}

export function buildImportsPath(options: PageOptions = {}): string {
	return buildPagePath('/imports', options);
}

export async function listAdminLibraries(options: RequestOptions = {}): Promise<Page<Library>> {
	return api.request(buildAdminLibrariesPath(options), { signal: options.signal });
}

/** Collects every library for selectors, guarding against a repeated cursor. */
export async function listAllAdminLibraries(signal?: AbortSignal): Promise<Library[]> {
	const libraries: Library[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	do {
		const page: Page<Library> = await listAdminLibraries({ cursor, limit: MAX_PAGE_SIZE, signal });
		libraries.push(...page.items);
		cursor = page.next_cursor;
		if (cursor !== null) {
			if (seen.has(cursor)) throw new Error('The libraries API returned a repeated pagination cursor.');
			seen.add(cursor);
		}
	} while (cursor !== null);
	return libraries;
}

export async function createLibrary(name: string, slug: string): Promise<Library> {
	return (await api.request<{ library: Library }>('/admin/libraries', { method: 'POST', body: { name, slug } })).library;
}

export async function updateLibrary(id: number, patch: LibraryPatch): Promise<Library> {
	const body: { [key: string]: JsonValue } = {};
	if (patch.name !== undefined) body.name = patch.name;
	if (patch.slug !== undefined) body.slug = patch.slug;
	return (await api.request<{ library: Library }>(`/admin/libraries/${id}`, { method: 'PATCH', body })).library;
}

export async function deleteLibrary(id: number): Promise<void> {
	await api.request<{ deleted: boolean }>(`/admin/libraries/${id}`, { method: 'DELETE' });
}

export async function listLibraryAccess(libraryID: number, options: RequestOptions = {}): Promise<Page<AccessEntry>> {
	return api.request(buildAccessPath(libraryID, options), { signal: options.signal });
}

export async function grantLibraryAccess(libraryID: number, userID: number): Promise<void> {
	await api.request<{ granted: boolean }>(`/admin/libraries/${libraryID}/access/${userID}`, { method: 'PUT' });
}

export async function revokeLibraryAccess(libraryID: number, userID: number): Promise<void> {
	await api.request<{ revoked: boolean }>(`/admin/libraries/${libraryID}/access/${userID}`, { method: 'DELETE' });
}

export async function listHiddenBooks(userID: number, options: RequestOptions = {}): Promise<Page<HiddenEntry>> {
	return api.request(buildHiddenBooksPath(userID, options), { signal: options.signal });
}

export async function hideBook(userID: number, bookID: number): Promise<void> {
	await api.request<{ hidden: boolean }>(`/admin/users/${userID}/hidden-books/${bookID}`, { method: 'PUT' });
}

export async function unhideBook(userID: number, bookID: number): Promise<void> {
	await api.request<{ hidden: boolean }>(`/admin/users/${userID}/hidden-books/${bookID}`, { method: 'DELETE' });
}

export async function listImports(options: RequestOptions = {}): Promise<Page<ImportJob>> {
	return api.request(buildImportsPath(options), { signal: options.signal });
}

async function problemFromResponse(response: Response): Promise<ApiError> {
	const body = await response.text();
	const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	let problem: ProblemDetails | undefined;
	if (mediaType === 'application/problem+json') {
		try {
			const parsed: unknown = JSON.parse(body);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) problem = parsed as ProblemDetails;
		} catch {
			problem = undefined;
		}
	}
	return new ApiError(response.status, response.statusText, body, problem);
}

export interface UploadOptions {
	readonly fetcher?: typeof fetch;
	readonly signal?: AbortSignal;
}

/**
 * Uploads exactly one file with the I1 multipart contract. The body is a FormData so
 * the browser generates the multipart boundary; the JSON client is not used.
 */
export async function uploadBook(libraryID: number, file: File, { fetcher = fetch, signal }: UploadOptions = {}): Promise<ImportJob> {
	const form = new FormData();
	form.append('library_id', String(libraryID));
	form.append('file', file, file.name);
	const response = await fetcher('/api/v1/uploads', { method: 'POST', body: form, signal });
	if (!response.ok) throw await problemFromResponse(response);
	return ((await response.json()) as { job: ImportJob }).job;
}

export async function listProviders(signal?: AbortSignal): Promise<ProviderSettings[]> {
	return (await api.request<{ providers: ProviderSettings[] }>('/admin/metadata/providers', { signal })).providers;
}

export async function updateProvider(provider: string, patch: ProviderPatch): Promise<ProviderSettings> {
	const body: { [key: string]: JsonValue } = {};
	if (patch.enabled !== undefined) body.enabled = patch.enabled;
	if (patch.priority !== undefined) body.priority = patch.priority;
	if (patch.base_url !== undefined) body.base_url = patch.base_url;
	if (patch.api_token !== undefined) body.api_token = patch.api_token;
	return (
		await api.request<{ provider: ProviderSettings }>(`/admin/metadata/providers/${encodeURIComponent(provider)}`, {
			method: 'PATCH',
			body
		})
	).provider;
}

export async function listMaintenanceJobs(signal?: AbortSignal): Promise<MaintenanceJob[]> {
	return (await api.request<{ jobs: MaintenanceJob[] }>('/admin/maintenance', { signal })).jobs;
}

export async function runMaintenanceJob(name: string): Promise<MaintenanceRun> {
	return (await api.request<{ run: MaintenanceRun }>(`/admin/maintenance/${encodeURIComponent(name)}`, { method: 'POST' })).run;
}
