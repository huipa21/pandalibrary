import { describe, expect, it } from 'vitest';
import { atEdge, wheelFactor } from './gestures.js';

describe('wheel zoom', () => {
	it('normalizes pixel, line and page delta modes', () => {
		expect(wheelFactor(16, 0)).toBeCloseTo(wheelFactor(1, 1));
		expect(wheelFactor(800, 0)).toBe(wheelFactor(1, 2));
		expect(wheelFactor(0, 0)).toBe(1);
		expect(wheelFactor(10, 0)).toBeLessThan(1);
		expect(wheelFactor(-10, 0)).toBeGreaterThan(1);
	});
	it('caps each wheel event', () => {
		expect(wheelFactor(10000, 0)).toBe(0.8);
		expect(wheelFactor(-10000, 0)).toBe(1.25);
	});
});

describe('edge paging', () => {
	it('turns only at the requested edge with rounding tolerance', () => {
		expect(atEdge(0.5, 800, 1600, -1)).toBe(true);
		expect(atEdge(799.5, 800, 1600, 1)).toBe(true);
		expect(atEdge(400, 800, 1600, 1)).toBe(false);
		expect(atEdge(400, 800, 1600, -1)).toBe(false);
		expect(atEdge(0, 800, 800, 1)).toBe(true);
	});
});
