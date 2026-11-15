import { describe, expect, it } from 'vitest';
import { entityIcon, selectableIcons } from './navigation-icons.js';

describe('entityIcon', () => {
	it('preserves selected icons regardless of the entity key', () => {
		for (const icon of selectableIcons) {
			expect(entityIcon(icon, 'library:1')).toBe(icon);
			expect(entityIcon(icon, 'collection:2')).toBe(icon);
		}
	});

	it('uses semantic automatic icons for libraries and collections, including legacy invalid values', () => {
		for (const icon of [undefined, '', null, '<script>', 'unknown']) {
			for (const id of [1, 4, 42]) {
				expect(entityIcon(icon, `library:${id}`)).toBe('library');
				expect(entityIcon(icon, `collection:${id}`)).toBe('folder');
			}
		}
	});

	it('keeps stable, varied fallbacks for other entity types', () => {
		expect(entityIcon(undefined, 'other:0')).toBe('file');
		expect(entityIcon(undefined, 'other:1')).toBe('list-tree');
		expect(entityIcon(undefined, 'other:2')).toBe('image');
		const keys = Array.from({ length: 40 }, (_, index) => `other:${index}`);
		const icons = keys.map((key) => entityIcon(undefined, key));
		expect(new Set(icons).size).toBeGreaterThan(1);
		for (const [index, key] of keys.entries()) {
			expect(selectableIcons).toContain(icons[index]);
			expect(entityIcon('', key)).toBe(icons[index]);
			expect(entityIcon(null, key)).toBe(icons[index]);
			expect(entityIcon('<script>', key)).toBe(icons[index]);
		}
	});
});
