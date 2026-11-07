import type { Book } from '#lib/catalog/types.js';

export const QUICK_VIEW_EVENT = 'pandalibrary-quick-view';
export const BOOK_STATE_CHANGED_EVENT = 'pandalibrary-book-state-changed';

export interface QuickViewRequest {
	bookId: number;
	book?: Book;
}

export interface QuickViewDetail extends QuickViewRequest {
	trigger: Element | null;
}

export interface BookStateChangedDetail {
	bookId: number;
}

export function openQuickView(detail: QuickViewRequest): void {
	window.dispatchEvent(new CustomEvent<QuickViewDetail>(QUICK_VIEW_EVENT, {
		detail: { ...detail, trigger: document.activeElement }
	}));
}

export function notifyBookStateChanged(bookId: number): void {
	window.dispatchEvent(new CustomEvent<BookStateChangedDetail>(BOOK_STATE_CHANGED_EVENT, {
		detail: { bookId }
	}));
}
