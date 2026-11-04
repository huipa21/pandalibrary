import { describe, expect, it } from 'vitest';
import { nextTrappedFocus } from './focus.js';

describe('nextTrappedFocus', () => {
	const cycle = ['toggle', 'first', 'last'];

	it('moves through the cycle in both directions', () => {
		expect(nextTrappedFocus(cycle, 'toggle', false)).toBe('first');
		expect(nextTrappedFocus(cycle, 'first', true)).toBe('toggle');
	});

	it('wraps forward from the last element and backward from the first', () => {
		expect(nextTrappedFocus(cycle, 'last', false)).toBe('toggle');
		expect(nextTrappedFocus(cycle, 'toggle', true)).toBe('last');
	});

	it('pulls focus back in when it escaped the drawer', () => {
		expect(nextTrappedFocus(cycle, 'outside', false)).toBe('toggle');
		expect(nextTrappedFocus(cycle, 'outside', true)).toBe('last');
		expect(nextTrappedFocus([], 'outside', false)).toBeNull();
	});
});
