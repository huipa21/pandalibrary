import { describe, expect, it } from 'vitest';
import { pointFromRotated, pointToRotated } from '../geometry.js';
import { imageRect, pointRect, resizeImage } from './geometry-insert.js';

describe('insert geometry', () => {
	it('clamps a chosen point inside every page rotation without shrinking the item', () => {
		for (const rotation of [0, 90, 180, 270]) {
			const point = { x: 0.95, y: 0.98 };
			const unrotated = pointFromRotated(pointToRotated(point, rotation), rotation);
			expect(pointRect(unrotated, 0.3, 0.2)).toEqual({ x: 0.7, y: 0.8, width: 0.3, height: 0.2 });
			expect(pointRect({ x: -1, y: 2 }, 3, 5)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		}
	});
	it('places portrait and landscape images at their physical aspect ratio', () => {
		for (const aspect of [0.01, 0.5, 2, 100]) {
			const rect = imageRect({ x: 0.9, y: 0.95 }, aspect, 600, 800);
			expect(rect.width * 600 / (rect.height * 800)).toBeCloseTo(aspect);
			expect(rect.x + rect.width).toBeLessThanOrEqual(1);
			expect(rect.y + rect.height).toBeLessThanOrEqual(1);
		}
	});
	it('resizes every corner with a fixed opposite anchor, aspect and minimum size', () => {
		const rect = { x: 0.2, y: 0.2, width: 0.3, height: 0.2 };
		for (const corner of ['nw', 'ne', 'sw', 'se']) {
			for (const point of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.35, y: 0.3 }]) {
				const result = resizeImage(rect, point, corner, 600, 800);
				expect(result.width / result.height).toBeCloseTo(1.5);
				expect(result.width * 600).toBeGreaterThanOrEqual(24 - 1e-8);
				expect(result.height * 800).toBeGreaterThanOrEqual(24 - 1e-8);
				expect(result.x + result.width).toBeLessThanOrEqual(1);
				expect(result.y + result.height).toBeLessThanOrEqual(1);
				expect(corner.includes('w') ? result.x + result.width : result.x).toBeCloseTo(corner.includes('w') ? 0.5 : 0.2);
			}
		}
	});
});
