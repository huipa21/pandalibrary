import * as m from '#lib/paraglide/messages.js';

export interface NavigationItem {
	readonly id: string;
	readonly href: string;
	readonly label: () => string;
	/** When set, the entry is only shown to viewers with this role. The server still authorizes every request. */
	readonly role?: string;
	/**
	 * `exact` marks the entry active only on its own path; `section` (the default) also marks it
	 * active on descendant paths such as `/authors/4`.
	 */
	readonly match?: 'exact' | 'section';
	/** Additional path sections that belong to this entry, for example `/library/3` for Libraries. */
	readonly sections?: readonly string[];
}

/**
 * Primary sidebar entries, in product order. All Books matches only `/books` itself: individual
 * book pages (`/books/<id>`) are reached from many places and do not imply the All Books list.
 */
export const homeNavigation: readonly NavigationItem[] = [
	{ id: 'dashboard', href: '/', label: m['ux1.nav.dashboard'], match: 'exact' },
	{ id: 'books', href: '/books', label: m['ux1.nav.all_books'], match: 'exact' },
	{ id: 'favorites', href: '/shelves/system/favorites', label: m['ux3.shelves.favorites'] },
	{ id: 'bookheap', href: '/bookheap', label: m['bh4.nav.bookheap'], role: 'admin' },
	{ id: 'notes', href: '/notes', label: m['notes.nav'] }
];

export function homeNavigationFor(role: string | null | undefined): readonly NavigationItem[] {
	return homeNavigation.filter((item) => item.role === undefined || item.role === role);
}

/** Secondary destinations that keep every existing feature reachable from the sidebar. */
export const navigation: readonly NavigationItem[] = [
	{ id: 'authors', href: '/authors', label: m['catalog.nav.authors'] },
	{ id: 'series', href: '/series', label: m['catalog.nav.series'] },
	{ id: 'tags', href: '/tags', label: m['catalog.nav.tags'] },
	{ id: 'reader', href: '/read', label: m['reader.nav'] },
	{ id: 'stats', href: '/stats', label: m['stats.nav'] },
	{ id: 'admin', href: '/admin', label: m['admin.nav'], role: 'admin' }
];

export function navigationFor(role: string | null | undefined): readonly NavigationItem[] {
	return navigation.filter((item) => item.role === undefined || item.role === role);
}

function withinSection(pathname: string, section: string): boolean {
	return pathname === section || pathname.startsWith(`${section}/`);
}

export function isActive(item: NavigationItem, pathname: string): boolean {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
	if (item.match === 'exact') return path === item.href;
	return [item.href, ...(item.sections ?? [])].some((section) => withinSection(path, section));
}

/** Reader pages give the book the full width and show the sidebar only as an on-demand drawer. */
export function isImmersiveRoute(pathname: string): boolean {
	return /^\/read\/[^/]+\/[^/]+\/?$/.test(pathname);
}
