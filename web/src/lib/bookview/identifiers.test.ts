import { describe, expect, it } from 'vitest';
import { identifierLinks } from './identifiers.js';

describe('identifier links', () => {
	it('maps ISBNs to the four safe provider searches and deduplicates them', () => {
		const links = identifierLinks([
			{ scheme: 'isbn13', value: '978 0/1&x' },
			{ scheme: 'ISBN13', value: '978 0/1&x' }
		]);
		expect(links.map((link) => link.provider)).toEqual(['openlibrary', 'google', 'goodreads', 'amazon']);
		for (const link of links) {
			if (link.provider === null) throw new Error('Expected a provider link.');
			expect(new URL(link.href).protocol).toBe('https:');
			expect(link.href).toContain('978%200%2F1%26x');
		}
	});

	it('maps provider IDs to fixed hosts and encodes untrusted values', () => {
		const links = identifierLinks([
			{ scheme: 'google', value: '//evil.example/?x=1' },
			{ scheme: 'goodreads', value: 'a/b' },
			{ scheme: 'asin', value: 'A&B' },
			{ scheme: 'openlibrary', value: '/works/OL123W' },
			{ scheme: 'openlibrary', value: 'OL456M' },
			{ scheme: 'openlibrary', value: 'other/value' }
		]);
		expect(links).toEqual([
			{ provider: 'google', value: '//evil.example/?x=1', href: 'https://books.google.com/books?id=%2F%2Fevil.example%2F%3Fx%3D1' },
			{ provider: 'goodreads', value: 'a/b', href: 'https://www.goodreads.com/book/show/a%2Fb' },
			{ provider: 'amazon', value: 'A&B', href: 'https://www.amazon.com/dp/A%26B' },
			{ provider: 'openlibrary', value: '/works/OL123W', href: 'https://openlibrary.org/works/OL123W' },
			{ provider: 'openlibrary', value: 'OL456M', href: 'https://openlibrary.org/books/OL456M' },
			{ provider: 'openlibrary', value: 'other/value', href: 'https://openlibrary.org/search?q=other%2Fvalue' }
		]);
	});

	it('keeps unknown schemes as plain text and handles malformed Unicode', () => {
		expect(identifierLinks([{ scheme: 'custom', value: '<script>bad</script>' }]))
			.toEqual([{ provider: null, scheme: 'custom', value: '<script>bad</script>' }]);
		expect(identifierLinks([{ scheme: 'google', value: '\ud800' }])[0])
			.toMatchObject({ href: 'https://books.google.com/books?id=%EF%BF%BD' });
	});
});
