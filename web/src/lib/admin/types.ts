export type { Library, Page } from '#lib/catalog/types.js';

/** UX8 user account visible to administrators. */
export interface User {
	readonly id: number;
	readonly username: string;
	readonly display_name: string;
	readonly role: 'admin' | 'user';
	readonly locale: 'en' | 'zh';
	readonly disabled: boolean;
	readonly created_at: string;
	readonly updated_at: string;
}

/** Omitted fields are unchanged. */
export interface UserPatch {
	readonly username?: string;
	readonly display_name?: string;
	readonly role?: string;
	readonly locale?: string;
	readonly disabled?: boolean;
}

/** C1 administrator-visible library grant. */
export interface AccessEntry {
	readonly user_id: number;
	readonly granted_at: string;
}

/** C1 hide-list entry; deliberately carries no book metadata. */
export interface HiddenEntry {
	readonly book_id: number;
	readonly hidden_by: number | null;
	readonly created_at: string;
}

/** Omitted fields are unchanged. The server rejects null for either field. */
export interface LibraryPatch {
	readonly name?: string;
	readonly slug?: string;
}

export type ImportStatus = 'pending' | 'processing' | 'imported' | 'duplicate' | 'failed';

/** I1 import job. `error` is already sanitized by the server. */
export interface ImportJob {
	readonly id: number;
	readonly source: string;
	readonly library_id: number;
	readonly user_id: number | null;
	readonly original_name: string;
	readonly sha256: string | null;
	readonly status: string;
	readonly error: string | null;
	readonly book_id: number | null;
	readonly duplicate_of_book_id: number | null;
	readonly created_at: string;
	readonly finished_at: string | null;
}

/** M1 provider settings. Tokens are write-only and never returned. */
export interface ProviderSettings {
	readonly provider: string;
	readonly enabled: boolean;
	readonly priority: number;
	readonly base_url: string | null;
	readonly has_token: boolean;
	readonly updated_at: string;
}

/** Omitted fields are preserved; `api_token: null` removes the token and `base_url: null` restores the default. */
export interface ProviderPatch {
	enabled?: boolean;
	priority?: number;
	base_url?: string | null;
	api_token?: string | null;
}

export type MaintenanceStatus = 'idle' | 'accepted' | 'running' | 'completed' | 'error';

export interface MaintenanceRun {
	readonly id: string;
	readonly status: string;
	readonly accepted_at: string;
	readonly started_at?: string;
	readonly completed_at?: string;
}

/** J1 maintenance job. Status is in-memory and resets when the server restarts. */
export interface MaintenanceJob {
	readonly name: string;
	readonly schedule: string;
	readonly status: string;
	readonly last_run: MaintenanceRun | null;
}
