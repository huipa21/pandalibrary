import { api } from '#lib/api/client.js';

export interface BuildInfo {
	version: string;
	commit: string;
	commit_date: string;
	dirty: boolean;
	release: string | null;
}

export type VersionState =
	| { status: 'loading' }
	| { status: 'ready'; info: BuildInfo }
	| { status: 'offline' }
	| { status: 'error' };

export async function fetchVersion(signal?: AbortSignal): Promise<BuildInfo> {
	const value = await api.request<unknown>('/version', { signal, cache: 'no-store', credentials: 'omit' });
	if (
		typeof value !== 'object' || value === null || Array.isArray(value) ||
		!('version' in value) || typeof value.version !== 'string' || value.version === '' ||
		!('commit' in value) || typeof value.commit !== 'string' || value.commit === '' ||
		!('commit_date' in value) || typeof value.commit_date !== 'string' || value.commit_date === '' ||
		!('dirty' in value) || typeof value.dirty !== 'boolean' ||
		!('release' in value) || (value.release !== null && (typeof value.release !== 'string' || value.release === ''))
	) {
		throw new Error('Invalid build version response');
	}
	return {
		version: value.version,
		commit: value.commit,
		commit_date: value.commit_date,
		dirty: value.dirty,
		release: value.release
	};
}

export function versionErrorState(error: unknown, online: boolean): 'offline' | 'error' {
	return !online || error instanceof TypeError ? 'offline' : 'error';
}
