import { afterEach, expect, it, vi } from 'vitest';
import { BOOK_STATE_CHANGED_EVENT, notifyBookStateChanged, openQuickView, QUICK_VIEW_EVENT } from './events.js';

afterEach(() => vi.unstubAllGlobals());

it('dispatches the quick-view request with the original focused trigger', () => {
	const target = new EventTarget();
	const trigger = { id: 'info-button' };
	vi.stubGlobal('window', target);
	vi.stubGlobal('document', { activeElement: trigger });
	const listener = vi.fn();
	target.addEventListener(QUICK_VIEW_EVENT, listener);
	openQuickView({ bookId: 21 });
	expect(listener).toHaveBeenCalledOnce();
	expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ bookId: 21, trigger });
});

it('notifies other views after book state changes', () => {
	const target = new EventTarget();
	vi.stubGlobal('window', target);
	const listener = vi.fn();
	target.addEventListener(BOOK_STATE_CHANGED_EVENT, listener);
	notifyBookStateChanged(7);
	expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ bookId: 7 });
});
