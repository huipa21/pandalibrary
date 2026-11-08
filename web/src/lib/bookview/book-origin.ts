import * as m from '#lib/paraglide/messages.js';
import { readBrowseContext, safeHref } from './browse-context.js';

export const BOOK_ORIGIN_KEY = 'pandalibrary.book-origin';

export interface BookOrigin {
	href: string;
	label: string | null;
}

function storage(): Storage | null {
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		return null;
	}
}

function pathOf(href: string): string {
	return href.split(/[?#]/, 1)[0];
}

/** `/books/{id}` and its tab subpaths; the metadata editor is a child flow instead. */
export function isBookArea(pathname: string): boolean {
	const match = /^\/books\/([^/]+)(?:\/([^/]*))?/.exec(pathname);
	return match !== null && match[2] !== 'edit';
}

/** The reader and the metadata editor return to the book without replacing its origin. */
export function isBookChildFlow(pathname: string, bookId?: number): boolean {
	const match = /^\/read\/([^/]+)\/[^/]+|^\/books\/([^/]+)\/edit(?:\/|$)/.exec(pathname);
	if (!match) return false;
	return bookId === undefined || (match[1] ?? match[2]) === String(bookId);
}

function acceptableOrigin(href: unknown): string | null {
	const safe = safeHref(href);
	if (safe === null) return null;
	const pathname = pathOf(safe);
	if (isBookArea(pathname) || isBookChildFlow(pathname) || /^\/(?:login|setup)(?:\/|$)/.test(pathname)) return null;
	return safe;
}

export function rememberBookOrigin(href: string, label?: string): void {
	const target = storage();
	const safe = acceptableOrigin(href);
	if (!target || safe === null) return;
	const origin: BookOrigin = { href: safe, label: typeof label === 'string' && label.trim() ? label : null };
	try {
		target.setItem(BOOK_ORIGIN_KEY, JSON.stringify(origin));
	} catch {
		// Without storage the back icon falls back to the Dashboard.
	}
}

export function readBookOrigin(): BookOrigin | null {
	const source = storage();
	if (!source) return null;
	try {
		const raw = source.getItem(BOOK_ORIGIN_KEY);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		const value = parsed as Record<string, unknown>;
		const href = acceptableOrigin(value.href);
		if (href === null) return null;
		return { href, label: typeof value.label === 'string' && value.label.trim() ? value.label : null };
	} catch {
		return null;
	}
}

/** A human name for an origin: the remembered list's label, else the route name. */
export function originLabel(href: string): string | null {
	const context = readBrowseContext();
	if (context && context.href === href && context.label.trim()) return context.label;
	const pathname = pathOf(href);
	if (pathname === '/') return m['bd1.origin.dashboard']();
	if (pathname === '/books') return m['bd1.origin.all_books']();
	if (pathname === '/search') return m['bd1.origin.search']();
	if (pathname === '/bookheap') return m['bd1.origin.bookheap']();
	if (pathname === '/bookmarks') return m['bd1.origin.bookmarks']();
	if (pathname === '/notes') return m['bd1.origin.notes']();
	const section = /^\/(shelves|authors|series|tags|library)\/[^/]/.exec(pathname)?.[1];
	switch (section) {
		case 'shelves': return m['bd1.origin.shelf']();
		case 'authors': return m['bd1.origin.author']();
		case 'series': return m['bd1.origin.series']();
		case 'tags': return m['bd1.origin.tag']();
		case 'library': return m['bd1.origin.library']();
		default: return null;
	}
}
