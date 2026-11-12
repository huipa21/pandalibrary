import * as m from '#lib/paraglide/messages.js';
import type { Attempt, AttemptStatus } from '../log-api.js';
import { readStatusLabel } from '../user-book.js';

export function attemptStatusLabel(status: AttemptStatus): string {
	switch (status) {
		case 'completed': return m['bv8.completed']();
		case 'in_progress': return m['bv8.in_progress']();
		case 'stopped': return m['bv8.stopped']();
	}
}

export function attemptTitle(attempt: Attempt): string {
	if (!attempt.outcome) return m['bv8.attempt']({ number: attempt.number, status: attemptStatusLabel(attempt.status) });
	const status = readStatusLabel(attempt.outcome);
	return attempt.number === 1
		? m['bv8.read_once']({ status })
		: m['bv8.read_count']({ count: attempt.number, status });
}

export function attemptMarkerClass(status: AttemptStatus): string {
	return status === 'completed' ? 'border-emerald-600 bg-emerald-600'
		: status === 'in_progress' ? 'border-emerald-600 bg-white' : 'border-slate-400 bg-slate-400';
}
