import { ApiError } from '#lib/api/client.js';

export interface CatalogErrorMessages {
	readonly api: string;
	readonly connection: string;
	readonly notFound: string;
}

export function catalogErrorMessage(
	error: unknown,
	messages: CatalogErrorMessages
): string {
	if (error instanceof ApiError) {
		return error.status === 404 ? messages.notFound : messages.api;
	}
	return messages.connection;
}
