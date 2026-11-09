import { describe, expect, it } from 'vitest';
import { toRotated } from '../geometry.js';
import type { NormalizedRect, PdfRotation } from '../types.js';
import { lastLine, MAX_PART_RECTS, normalizeSelectionText, toPageRects } from './selection.js';

const PAGE = { width: 600, height: 800 };

/** A page box at (100, 50) and the client rect of `rect` (unrotated, normalized) shown at `rotation`. */
function onScreen(rect: NormalizedRect, rotation: PdfRotation) {
	const turned = rotation === 90 || rotation === 270;
	const width = turned ? PAGE.height : PAGE.width;
	const height = turned ? PAGE.width : PAGE.height;
	const bounds = { left: 100, top: 50, right: 100 + width, bottom: 50 + height };
	const r = toRotated(rect, rotation);
	const client = {
		left: bounds.left + r.x * width, top: bounds.top + r.y * height,
		right: bounds.left + (r.x + r.width) * width, bottom: bounds.top + (r.y + r.height) * height
	};
	return { bounds, client };
}

function expectClose(actual: NormalizedRect[], expected: NormalizedRect[]) {
	expect(actual).toHaveLength(expected.length);
	actual.forEach((rect, index) => {
		for (const key of ['x', 'y', 'width', 'height'] as const) expect(rect[key]).toBeCloseTo(expected[index][key], 4);
	});
}

describe('toPageRects', () => {
	const word = { x: 0.1, y: 0.2, width: 0.3, height: 0.025 };

	for (const rotation of [0, 90, 180, 270] as const) {
		it(`stores rects in unrotated page space at rotation ${rotation}`, () => {
			const { bounds, client } = onScreen(word, rotation);
			expectClose(toPageRects([client], bounds, rotation), [word]);
		});
	}

	it('merges the rects of one line and keeps separate lines', () => {
		const parts = [
			{ x: 0.1, y: 0.2, width: 0.1, height: 0.02 },
			{ x: 0.2, y: 0.2, width: 0.15, height: 0.02 },
			{ x: 0.1, y: 0.25, width: 0.2, height: 0.02 }
		];
		for (const rotation of [0, 90] as const) {
			const screens = parts.map((part) => onScreen(part, rotation));
			expectClose(toPageRects(screens.map((s) => s.client), screens[0].bounds, rotation), [
				{ x: 0.1, y: 0.2, width: 0.25, height: 0.02 },
				{ x: 0.1, y: 0.25, width: 0.2, height: 0.02 }
			]);
		}
	});

	it('clips rects to the page and drops empty ones', () => {
		const bounds = { left: 0, top: 0, right: 600, bottom: 800 };
		const rects = toPageRects([
			{ left: -50, top: 100, right: 60, bottom: 120 },
			{ left: 700, top: 100, right: 800, bottom: 120 },
			{ left: 10, top: 10, right: 10.2, bottom: 30 }
		], bounds, 0);
		expectClose(rects, [{ x: 0, y: 0.125, width: 0.1, height: 0.025 }]);
	});

	it('returns nothing for an empty page box', () => {
		expect(toPageRects([{ left: 0, top: 0, right: 10, bottom: 10 }], { left: 0, top: 0, right: 0, bottom: 0 }, 0)).toEqual([]);
	});

	it(`caps a part at ${MAX_PART_RECTS} rects`, () => {
		const bounds = { left: 0, top: 0, right: 600, bottom: 8000 };
		const lines = Array.from({ length: 250 }, (_, index) => ({ left: 10, top: index * 30, right: 200, bottom: index * 30 + 20 }));
		expect(toPageRects(lines, bounds, 0)).toHaveLength(MAX_PART_RECTS);
	});
});

describe('normalizeSelectionText', () => {
	it('trims lines, collapses spaces and drops empty lines', () => {
		expect(normalizeSelectionText('  First   line \r\n\n\tsecond\u00a0 line  ')).toBe('First line\nsecond line');
	});

	it('joins wrapped CJK lines without a break', () => {
		expect(normalizeSelectionText('中文文本\n继续')).toBe('中文文本继续');
		expect(normalizeSelectionText('中文\nEnglish')).toBe('中文\nEnglish');
	});
});

describe('lastLine', () => {
	it('unions the rects on the last line', () => {
		expect(lastLine([
			{ left: 0, top: 0, right: 50, bottom: 10 },
			{ left: 0, top: 20, right: 30, bottom: 30 },
			{ left: 35, top: 21, right: 80, bottom: 31 }
		])).toEqual({ left: 0, top: 20, right: 80, bottom: 31 });
	});

	it('is null without rects', () => {
		expect(lastLine([])).toBeNull();
	});
});
