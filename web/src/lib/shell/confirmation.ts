import { writable } from 'svelte/store';

export interface Confirmation {
	message: string;
	resolve: (accepted: boolean) => void;
}

export const confirmation = writable<Confirmation | null>(null);
let pending: Confirmation | null = null;

export function confirmAction(message: string): Promise<boolean> {
	// Ignore repeated actions while the modal owns focus.
	if (pending) return Promise.resolve(false);
	return new Promise((resolve) => {
		pending = {
			message,
			resolve(accepted) {
				pending = null;
				confirmation.set(null);
				resolve(accepted);
			}
		};
		confirmation.set(pending);
	});
}

export function cancelConfirmation() {
	pending?.resolve(false);
}

export type DraftGuard = () => boolean | Promise<boolean>;

export function checkDraftGuards(guards: readonly DraftGuard[]): boolean | Promise<boolean> {
	for (let index = 0; index < guards.length; index++) {
		const result = guards[index]();
		if (result instanceof Promise) {
			return result.then((accepted) => accepted && checkDraftGuards(guards.slice(index + 1)));
		}
		if (!result) return false;
	}
	return true;
}
