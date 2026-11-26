import * as m from '#lib/paraglide/messages.js';

/** Localized display name for a metadata provider. */
export function providerName(provider: string): string {
	switch (provider) {
		case 'openlibrary':
			return m['admin.providers.name.openlibrary']();
		case 'googlebooks':
			return m['admin.providers.name.googlebooks']();
		case 'neodb':
			return m['admin.providers.name.neodb']();
		case 'hardcover':
			return m['admin.providers.name.hardcover']();
		case 'crossref':
			return m['admin.providers.name.crossref']();
		case 'openbd':
			return m['admin.providers.name.openbd']();
		case 'douban':
			return m['admin.providers.name.douban']();
		case 'amazon':
			return m['admin.providers.name.amazon']();
		case 'goodreads':
			return m['admin.providers.name.goodreads']();
		default:
			return provider;
	}
}
