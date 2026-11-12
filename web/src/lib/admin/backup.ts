import { api, toApiError } from '#lib/api/client.js';

export interface Backup {
	name: string;
	size_bytes: number;
	created_at: string;
}

export interface BackupList {
	backups: Backup[];
	restore_pending: boolean;
}

interface StagedRestore {
	status: string;
	restore_pending: boolean;
	restart_required: boolean;
}

export function listBackups(signal?: AbortSignal): Promise<BackupList> {
	return api.request('/admin/backups', { signal });
}

export async function createBackup(): Promise<Backup> {
	return (await api.request<{ backup: Backup }>('/admin/backups', { method: 'POST', body: {} })).backup;
}

export function backupDownloadPath(name: string): string {
	return `/api/v1/admin/backups/${encodeURIComponent(name)}`;
}

export async function restoreBackup(source: string | File): Promise<void> {
	let result: StagedRestore;
	if (typeof source === 'string') {
		result = await api.request<StagedRestore>('/admin/backups/restore', { method: 'POST', body: { name: source, confirm: true } });
	} else {
		const form = new FormData();
		form.append('confirm', 'true');
		form.append('file', source, source.name);
		const response = await fetch('/api/v1/admin/backups/restore', { method: 'POST', body: form });
		if (!response.ok) throw await toApiError(response);
		result = await response.json();
	}
	if (result?.status !== 'staged' || result.restore_pending !== true || result.restart_required !== true) {
		throw new Error('The server did not confirm a staged restore.');
	}
}
