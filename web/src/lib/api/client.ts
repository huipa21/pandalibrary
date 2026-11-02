export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ProblemDetails {
	readonly type?: string;
	readonly title?: string;
	readonly status?: number;
	readonly detail?: string;
	readonly instance?: string;
	readonly [extension: string]: unknown;
}

export interface ApiRequestOptions<TBody extends JsonValue = JsonValue>
	extends Omit<RequestInit, 'body'> {
	readonly body?: TBody;
}

export interface ApiClientOptions {
	readonly basePath?: string;
	readonly fetcher?: typeof fetch;
}

export class ApiError extends Error {
	readonly status: number;
	readonly statusText: string;
	readonly problem?: ProblemDetails;
	readonly responseBody: string;

	constructor(
		status: number,
		statusText: string,
		responseBody: string,
		problem?: ProblemDetails,
		message?: string
	) {
		super(message ?? problem?.detail ?? problem?.title ?? `HTTP ${status} ${statusText}`.trim());
		this.name = 'ApiError';
		this.status = status;
		this.statusText = statusText;
		this.responseBody = responseBody;
		this.problem = problem;
	}
}

function isProblemDetails(value: unknown): value is ProblemDetails {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return (
		(candidate.type === undefined || typeof candidate.type === 'string') &&
		(candidate.title === undefined || typeof candidate.title === 'string') &&
		(candidate.status === undefined || typeof candidate.status === 'number') &&
		(candidate.detail === undefined || typeof candidate.detail === 'string') &&
		(candidate.instance === undefined || typeof candidate.instance === 'string')
	);
}

async function toApiError(response: Response): Promise<ApiError> {
	const responseBody = await response.text();
	const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();

	if (mediaType !== 'application/problem+json') {
		return new ApiError(response.status, response.statusText, responseBody);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(responseBody);
	} catch {
		return new ApiError(
			response.status,
			response.statusText,
			responseBody,
			undefined,
			`HTTP ${response.status}: invalid application/problem+json response`
		);
	}

	if (!isProblemDetails(parsed)) {
		return new ApiError(
			response.status,
			response.statusText,
			responseBody,
			undefined,
			`HTTP ${response.status}: invalid application/problem+json response`
		);
	}

	return new ApiError(response.status, response.statusText, responseBody, parsed);
}

function joinBasePath(basePath: string, path: string): string {
	return `${basePath.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function createApiClient({ basePath = '/api/v1', fetcher = fetch }: ApiClientOptions = {}) {
	return {
		async request<TResponse, TBody extends JsonValue = JsonValue>(
			path: string,
			options: ApiRequestOptions<TBody> = {}
		): Promise<TResponse> {
			const { body, ...init } = options;
			const headers = new Headers(init.headers);
			const request: RequestInit = { ...init, headers };

			if (body !== undefined) {
				headers.set('content-type', 'application/json');
				request.body = JSON.stringify(body);
			}

			const response = await fetcher(joinBasePath(basePath, path), request);
			if (!response.ok) {
				throw await toApiError(response);
			}

			return (await response.json()) as TResponse;
		}
	};
}

export const api = createApiClient();
