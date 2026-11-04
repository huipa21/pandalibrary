import * as m from '#lib/paraglide/messages.js';

export interface NavigationItem {
	readonly id: string;
	readonly href: string;
	readonly label: () => string;
	/** When set, the entry is only shown to viewers with this role. The server still authorizes every request. */
	readonly role?: string;
}

export function navigationFor(role: string | null | undefined): readonly NavigationItem[] {
	return navigation.filter((item) => item.role === undefined || item.role === role);
}

export const navigation: readonly NavigationItem[] = [
	{ id: 'libraries', href: '/', label: m['catalog.nav.libraries'] },
	{ id: 'authors', href: '/authors', label: m['catalog.nav.authors'] },
	{ id: 'series', href: '/series', label: m['catalog.nav.series'] },
	{ id: 'tags', href: '/tags', label: m['catalog.nav.tags'] },
	{ id: 'reader', href: '/read', label: m['reader.nav'] },
	{ id: 'search', href: '/search', label: m['search.nav'] },
	{ id: 'shelves', href: '/shelves', label: m['shelves.nav'] },
	{ id: 'notes', href: '/notes', label: m['notes.nav'] },
	{ id: 'stats', href: '/stats', label: m['stats.nav'] },
	{ id: 'admin', href: '/admin', label: m['admin.nav'], role: 'admin' }
];
