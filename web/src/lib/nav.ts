import * as m from '#lib/paraglide/messages.js';

export interface NavigationItem {
	readonly id: string;
	readonly href: string;
	readonly label: () => string;
}

export const navigation: readonly NavigationItem[] = [
	{ id: 'libraries', href: '/', label: m['catalog.nav.libraries'] },
	{ id: 'authors', href: '/authors', label: m['catalog.nav.authors'] },
	{ id: 'series', href: '/series', label: m['catalog.nav.series'] },
	{ id: 'tags', href: '/tags', label: m['catalog.nav.tags'] }
];
