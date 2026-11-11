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

export const BOOK_ORIGIN_SCROLL_KEY = 'pandalibrary.book-origin-scroll';

/** Remembers the scroll position of the page a book is opened from. */
export function rememberOriginScroll(href: string, y: number): void {
	const target = storage();
	const safe = acceptableOrigin(href);
	if (!target || safe === null || !Number.isFinite(y) || y < 0) return;
	try {
		target.setItem(BOOK_ORIGIN_SCROLL_KEY, JSON.stringify({ href: safe, y: Math.round(y) }));
	} catch {
		// Scroll restoration is a nicety.
	}
}

export function readOriginScroll(href: string): number | null {
	const source = storage();
	if (!source) return null;
	try {
		const raw = source.getItem(BOOK_ORIGIN_SCROLL_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as Record<string, unknown> | null;
		if (!value || value.href !== href || typeof value.y !== 'number' || !Number.isFinite(value.y) || value.y <= 0) return null;
		return value.y;
	} catch {
		return null;
	}
}

/**
 * Origin pages such as the Dashboard load their content after navigation, so the router's
 * scroll restoration is clamped to a short page. Re-apply the remembered position once the
 * page at `href` is tall enough, unless the user scrolls first.
 */
export function restoreOriginScroll(href: string, timeoutMs = 5000): void {
	const y = readOriginScroll(href);
	if (y === null || typeof window === 'undefined') return;
	const started = performance.now();
	let heldSince: number | null = null;
	let cancelled = false;
	const cancel = () => { cancelled = true; };
	const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
	for (const name of events) window.addEventListener(name, cancel, { passive: true, capture: true });
	const stop = () => { for (const name of events) window.removeEventListener(name, cancel, { capture: true }); };
	const step = () => {
		const now = performance.now();
		if (cancelled || now - started > timeoutMs) return stop();
		if (location.pathname + location.search === href) {
			const reachable = document.documentElement.scrollHeight - window.innerHeight >= y - 1;
			if (Math.abs(window.scrollY - y) <= 1) {
				heldSince ??= now;
				// Keep watching briefly in case the router scrolls after rendering.
				if (now - heldSince > 400) return stop();
			} else {
				heldSince = null;
				if (reachable) window.scrollTo(window.scrollX, y);
			}
		}
		requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}

/** A human name for an origin: the remembered list's label, else the route name. */
export function originLabel(href: string): string | null {
	const pathname = pathOf(href);
	// Dashboard rows remember their row title, but the back target is the whole Dashboard.
	if (pathname === '/') return m['bd1.origin.dashboard']();
	const context = readBrowseContext();
	if (context && context.href === href && context.label.trim()) return context.label;
	if (pathname === '/books') return m['bd1.origin.all_books']();
	if (pathname === '/search') return m['bd1.origin.search']();
	if (pathname === '/bookheap') return m['bd1.origin.bookheap']();
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
