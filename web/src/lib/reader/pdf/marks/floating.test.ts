import { describe, expect, it } from 'vitest';
import { intersects, placeAbove, unionRect } from './floating.js';

const viewport = { left: 0, top: 0, right: 360, bottom: 640 };
const size = { width: 240, height: 44 };

describe('placeAbove', () => {
	it('centres the element above the anchor', () => {
		expect(placeAbove({ left: 100, top: 300, right: 260, bottom: 320 }, size, viewport)).toEqual({ left: 60, top: 248, placement: 'above' });
	});

	it('clamps horizontally inside the viewport', () => {
		expect(placeAbove({ left: 0, top: 300, right: 20, bottom: 320 }, size, viewport).left).toBe(8);
		expect(placeAbove({ left: 340, top: 300, right: 360, bottom: 320 }, size, viewport).left).toBe(112);
	});

	it('flips below when there is no room above', () => {
		expect(placeAbove({ left: 100, top: 20, right: 260, bottom: 40 }, size, viewport)).toEqual({ left: 60, top: 48, placement: 'below' });
	});

	it('stays inside the viewport when the anchor is below it', () => {
		const placed = placeAbove({ left: 100, top: 900, right: 260, bottom: 920 }, size, viewport);
		expect(placed.top).toBe(640 - 8 - 44);
	});

	it('pins to the start when the element is wider than the viewport', () => {
		expect(placeAbove({ left: 100, top: 300, right: 120, bottom: 320 }, { width: 500, height: 44 }, viewport).left).toBe(8);
	});

	it('respects an offset viewport and gap', () => {
		const offset = { left: 100, top: 100, right: 500, bottom: 500 };
		expect(placeAbove({ left: 200, top: 120, right: 300, bottom: 140 }, { width: 100, height: 20 }, offset, 4))
			.toEqual({ left: 200, top: 144, placement: 'below' });
	});
});

describe('rect helpers', () => {
	it('detects intersection', () => {
		expect(intersects({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 20, bottom: 20 })).toBe(true);
		expect(intersects({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
	});

	it('unions rects', () => {
		expect(unionRect([])).toBeNull();
		expect(unionRect([{ left: 5, top: 5, right: 10, bottom: 10 }, { left: 0, top: 7, right: 8, bottom: 20 }]))
			.toEqual({ left: 0, top: 5, right: 10, bottom: 20 });
	});
});
