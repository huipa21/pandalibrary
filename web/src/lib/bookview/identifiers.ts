import type { Identifier } from '#lib/catalog/types.js';

export type Provider = 'google' | 'openlibrary' | 'goodreads' | 'amazon';

export type IdentifierItem =
	| { provider: Provider; value: string; href: string }
	| { provider: null; scheme: string; value: string };

function openLibraryUrl(value: string, encoded: string): string {
	const match = /^(?:\/?(books|works)\/)?(OL\d+([MW]))$/i.exec(value.trim());
	if (!match) return `https://openlibrary.org/search?q=${encoded}`;
	const kind = match[1]?.toLowerCase() ?? (match[3].toUpperCase() === 'W' ? 'works' : 'books');
	return `https://openlibrary.org/${kind}/${encodeURIComponent(match[2])}`;
}

export function identifierLinks(identifiers: readonly Identifier[]): IdentifierItem[] {
	const items: IdentifierItem[] = [];
	const seen = new Set<string>();
	const add = (provider: Provider, value: string, href: string) => {
		const key = `${provider}:${href}`;
		if (!seen.has(key)) {
			seen.add(key);
			items.push({ provider, value, href });
		}
	};
	for (const { scheme, value } of identifiers) {
		const encoded = encodeURIComponent(value.toWellFormed());
		switch (scheme.trim().toLowerCase()) {
			case 'isbn':
			case 'isbn10':
			case 'isbn13':
				add('openlibrary', value, `https://openlibrary.org/isbn/${encoded}`);
				add('google', value, `https://books.google.com/books?q=isbn%3A${encoded}`);
				add('goodreads', value, `https://www.goodreads.com/search?q=${encoded}`);
				add('amazon', value, `https://www.amazon.com/s?k=${encoded}`);
				break;
			case 'google':
				add('google', value, `https://books.google.com/books?id=${encoded}`);
				break;
			case 'goodreads':
				add('goodreads', value, `https://www.goodreads.com/book/show/${encoded}`);
				break;
			case 'amazon':
			case 'asin':
				add('amazon', value, `https://www.amazon.com/dp/${encoded}`);
				break;
			case 'openlibrary':
				add('openlibrary', value, openLibraryUrl(value, encoded));
				break;
			default:
				items.push({ provider: null, scheme, value });
		}
	}
	return items;
}
