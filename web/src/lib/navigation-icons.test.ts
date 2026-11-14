import { describe, expect, it } from 'vitest';
import { entityIcon, selectableIcons } from './navigation-icons.js';

describe('entityIcon', () => {
	it('preserves selected icons regardless of the entity key', () => {
		for (const icon of selectableIcons) {
			expect(entityIcon(icon, 'library:1')).toBe(icon);
			expect(entityIcon(icon, 'collection:2')).toBe(icon);
		}
	});

	it('gives legacy and invalid icons a stable, varied fallback', () => {
		const keys = Array.from({ length: 40 }, (_, index) => `collection:${index}`);
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
