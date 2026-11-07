import * as m from '#lib/paraglide/messages.js';
import type { HeapItemStatus } from './types.js';

export const heapStatusLabels: Record<HeapItemStatus, () => string> = {
	ready: m['bh4.status.ready'],
	duplicate: m['bh4.status.duplicate'],
	invalid: m['bh4.status.invalid'],
	queued: m['bh4.status.queued'],
	importing: m['bh4.status.importing'],
	failed: m['bh4.status.failed']
};

export const heapStatusClasses: Record<HeapItemStatus, string> = {
	ready: 'border-emerald-200 bg-emerald-50 text-emerald-900',
	duplicate: 'border-amber-300 bg-amber-50 text-amber-950',
	invalid: 'border-red-200 bg-red-50 text-red-900',
	queued: 'border-sky-200 bg-sky-50 text-sky-900',
	importing: 'border-sky-200 bg-sky-50 text-sky-900',
	failed: 'border-red-200 bg-red-50 text-red-900'
};
