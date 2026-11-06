/** Window event (no payload) dispatched after uploads, scans, deletions and assignments. */
export const BOOKHEAP_CHANGED_EVENT = 'pandalibrary-bookheap-changed';

export function notifyBookheapChanged(target: EventTarget | undefined = globalThis.window): void {
	target?.dispatchEvent(new Event(BOOKHEAP_CHANGED_EVENT));
}
