import { describe, expect, it, vi } from 'vitest';
import { bookTabFromPath, bookTabPath, visibleBookTabs } from './BookTabs.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('https://library.invalid/books/7') } }));

describe('book Words tab navigation', () => {
	it('is available to readers as well as metadata editors', () => {
		expect(visibleBookTabs(false)).toContain('words');
		expect(visibleBookTabs(false)).not.toContain('metadata');
		expect(visibleBookTabs(true)).toContain('words');
	});

	it('preserves the Words tab when switching books and recognizes deep links', () => {
		expect(bookTabPath(7, bookTabFromPath('/books/4/words/'))).toBe('/books/7/words');
		expect(bookTabFromPath('/books/4/reading-log')).toBe('activities');
		expect(bookTabPath(7, 'details')).toBe('/books/7');
	});
});
