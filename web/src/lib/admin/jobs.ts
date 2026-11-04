import { getLocale } from '#lib/paraglide/runtime.js';
import type { ImportJob, MaintenanceJob } from './types.js';

export const IMPORT_STATUSES = ['pending', 'processing', 'imported', 'duplicate', 'failed'] as const;
export const MAINTENANCE_STATUSES = ['idle', 'accepted', 'running', 'completed', 'error'] as const;
export const MAINTENANCE_JOBS = ['cleanup-expired', 'backup', 'orphan-sweep', 'optimize', 'fts-check', 'wal-checkpoint'] as const;

export function isActiveImport(job: ImportJob): boolean {
	return job.status === 'pending' || job.status === 'processing';
}

/**
 * Merges a freshly polled first page into an already displayed history. Known jobs are
 * updated in place, newer jobs are prepended, and older loaded pages and their cursor are
 * kept because the I1 cursor is an ID bound that new jobs cannot shift.
 */
export function mergeImportPage(current: readonly ImportJob[], fresh: readonly ImportJob[]): ImportJob[] {
	const updates = new Map(fresh.map((job) => [job.id, job]));
	const known = new Set(current.map((job) => job.id));
	const newest = current.reduce((max, job) => Math.max(max, job.id), 0);
	const added = fresh.filter((job) => !known.has(job.id) && job.id > newest);
	return [...added, ...current.map((job) => updates.get(job.id) ?? job)];
}

export function isMaintenanceActive(job: MaintenanceJob): boolean {
	return job.status === 'accepted' || job.status === 'running';
}

/** Parses Go `time.Duration` strings such as `24h0m0s` or `5m0s` into seconds. */
export function parseGoDuration(value: string): number | null {
	if (!/^(\d+h)?(\d+m)?(\d+(\.\d+)?s)?$/.test(value) || value === '') return null;
	let seconds = 0;
	for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)([hms])/g)) {
		seconds += Number(amount) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
	}
	return seconds;
}

export type ScheduleParts =
	| { readonly unit: 'hours' | 'minutes' | 'seconds'; readonly count: number }
	| { readonly unit: 'raw'; readonly text: string };

export function scheduleParts(schedule: string): ScheduleParts {
	const seconds = parseGoDuration(schedule);
	if (seconds === null || seconds <= 0) return { unit: 'raw', text: schedule };
	if (seconds % 3600 === 0) return { unit: 'hours', count: seconds / 3600 };
	if (seconds % 60 === 0) return { unit: 'minutes', count: seconds / 60 };
	return { unit: 'seconds', count: seconds };
}

/** Formats a UTC RFC3339 timestamp in the active locale, falling back to the raw value. */
export function formatTimestamp(value: string | null | undefined, locale: string = getLocale()): string {
	if (!value) return '';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
