import { describe, expect, it } from 'vitest';
import { areaPath, chartPositions, chartWeights, pieSlices, treemapRects } from './chart-geometry.js';

describe('distribution geometry', () => {
	it('ignores invalid counts and scales large counts without overflowing', () => {
		expect(chartWeights([0, -1, NaN, Infinity, Number.MAX_VALUE, Number.MAX_VALUE / 2]))
			.toEqual([0, 0, 0, 0, 1, 0.5]);
		expect(pieSlices([Number.MAX_VALUE, Number.MAX_VALUE]).every((slice) => !slice.path.includes('NaN'))).toBe(true);
	});

	it('partitions the full rectangle in proportion to counts without overlapping', () => {
		const values = [8, 3, 2, 1, 0];
		const rects = treemapRects(values, 120, 80);
		expect(rects).toHaveLength(4);
		for (const rect of rects) {
			expect(rect.width * rect.height).toBeCloseTo(120 * 80 * values[rect.index] / 14);
			expect(rect.x).toBeGreaterThanOrEqual(0);
			expect(rect.y).toBeGreaterThanOrEqual(0);
			expect(rect.x + rect.width).toBeLessThanOrEqual(120 + 1e-10);
			expect(rect.y + rect.height).toBeLessThanOrEqual(80 + 1e-10);
			for (const other of rects.filter((item) => item.index !== rect.index)) {
				const overlapWidth = Math.min(rect.x + rect.width, other.x + other.width) - Math.max(rect.x, other.x);
				const overlapHeight = Math.min(rect.y + rect.height, other.y + other.height) - Math.max(rect.y, other.y);
				expect(overlapWidth <= 1e-10 || overlapHeight <= 1e-10).toBe(true);
			}
		}
		expect(treemapRects([0, -2])).toEqual([]);
		expect(treemapRects([9])).toEqual([{ index: 0, x: 0, y: 0, width: 100, height: 100 }]);
	});

	it('draws a full circle for a single positive slice and a large arc for a majority', () => {
		expect(pieSlices([0, 4])[0]).toEqual({
			index: 1, path: 'M 100 10 A 90 90 0 1 1 100 190 A 90 90 0 1 1 100 10 Z'
		});
		const slices = pieSlices([3, 1]);
		expect(slices[0].path).toContain('A 90 90 0 1 1');
		expect(slices[1].path).toContain('A 90 90 0 0 1');
		expect(pieSlices([0, 0])).toEqual([]);
	});

	it('closes area graphs at the baseline including single-point and zero gaps', () => {
		expect(areaPath([4], 100, 50)).toBe('M 0 50 L 0 0 L 100 0 L 100 50 Z');
		expect(areaPath([2, 0, 1], 120, 60)).toBe('M 20 60 L 20 0 L 60 60 L 100 30 L 100 60 Z');
		expect(areaPath([])).toBe('');
		expect(areaPath([0])).toBe('');
	});

	it('preserves publication year gaps but evenly spaces nonnumeric categories', () => {
		const positions = chartPositions(['1900', '1901', '2000']);
		expect(positions[1] - positions[0]).toBeCloseTo((positions[2] - positions[0]) / 100);
		expect(chartPositions(['old', 'new'])).toEqual([0.25, 0.75]);
		expect(chartPositions(['2026'])).toEqual([0.5]);
		expect(areaPath([1, 2, 1], 600, 200, positions)).toContain(`L ${positions[1] * 600} 0`);
	});
});
