/** Window event (no payload) dispatched after books become visible or invisible (hide/unhide, delete). */
export const BOOKS_CHANGED_EVENT = 'pandalibrary-books-changed';

export function notifyBooksChanged(target: EventTarget | undefined = globalThis.window): void {
	target?.dispatchEvent(new Event(BOOKS_CHANGED_EVENT));
}
