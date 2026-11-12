/** Window event (no payload) dispatched after uploads, scans, deletions and assignments. */
export const BOOKHEAP_CHANGED_EVENT = 'pandalibrary-bookheap-changed';
/** Background imports progressed; refresh consumers without restarting the count watcher. */
export const BOOKHEAP_PROGRESS_EVENT = 'pandalibrary-bookheap-progress';

export function notifyBookheapChanged(target: EventTarget | undefined = globalThis.window): void {
	target?.dispatchEvent(new Event(BOOKHEAP_CHANGED_EVENT));
}
