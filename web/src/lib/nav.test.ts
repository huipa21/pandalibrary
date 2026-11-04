import { describe, expect, it } from 'vitest';
import { navigationFor } from './nav.js';

describe('navigationFor', () => {
	it('shows the admin entry only to administrators', () => {
		expect(navigationFor('admin').some((item) => item.id === 'admin')).toBe(true);
		expect(navigationFor('user').some((item) => item.id === 'admin')).toBe(false);
		expect(navigationFor(null).some((item) => item.id === 'admin')).toBe(false);
		expect(navigationFor('user').some((item) => item.id === 'libraries')).toBe(true);
	});
});
