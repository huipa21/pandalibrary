import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { cancelConfirmation, checkDraftGuards, confirmAction, confirmation } from './confirmation.js';

afterEach(cancelConfirmation);

describe('in-app confirmations', () => {
	it('waits for an explicit response and rejects duplicate actions', async () => {
		const result = confirmAction('Delete?');
		expect(get(confirmation)?.message).toBe('Delete?');
		expect(await confirmAction('Duplicate')).toBe(false);
		get(confirmation)?.resolve(true);
		expect(await result).toBe(true);
		expect(get(confirmation)).toBeNull();
	});

	it('cancels pending work when the dialog is dismissed or disposed', async () => {
		const result = confirmAction('Discard?');
		cancelConfirmation();
		expect(await result).toBe(false);
		expect(get(confirmation)).toBeNull();
	});

	it('awaits draft guards in order and stops when one rejects', async () => {
		const later = vi.fn(() => true);
		const result = checkDraftGuards([() => confirmAction('Discard?'), later]);
		expect(later).not.toHaveBeenCalled();
		cancelConfirmation();
		expect(await result).toBe(false);
		expect(later).not.toHaveBeenCalled();
		const accepted = checkDraftGuards([() => confirmAction('Discard?'), later]);
		get(confirmation)?.resolve(true);
		expect(await accepted).toBe(true);
		expect(later).toHaveBeenCalledOnce();
	});
});
