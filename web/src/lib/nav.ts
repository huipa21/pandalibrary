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
 * Primary sidebar entries, in product order. The computed all-book list remains
 * available at `/books` but is not a physical library or a sidebar destination.
 */
export const homeNavigation: readonly NavigationItem[] = [
	{ id: 'dashboard', href: '/', label: m['ux1.nav.dashboard'], match: 'exact' },
	{ id: 'bookheap', href: '/bookheap', label: m['bh4.nav.bookheap'], role: 'admin' },
	{ id: 'favorites', href: '/shelves/system/favorites', label: m['ux3.shelves.favorites'] },
	{ id: 'notes', href: '/notes', label: m['notes.nav'] }
];

export function homeNavigationFor(role: string | null | undefined): readonly NavigationItem[] {
	return homeNavigation.filter((item) => item.role === undefined || item.role === role);
}

/** Statistics are distinct views of the same visible reading data. */
export const navigation: readonly NavigationItem[] = [
	{ id: 'stats-books', href: '/stats/books', label: m['organize.books'] },
	{ id: 'stats-reading', href: '/stats/reading', label: m['organize.reading'] },
	{ id: 'stats-history', href: '/stats/history', label: m['organize.history'] }
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
