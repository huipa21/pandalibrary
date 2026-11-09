import { describe, expect, it } from 'vitest';
import { PAGE_ANNOTATION_LIMITS, validatePageAnnotationInput } from '../../page-annotations.js';
import { finishInk, inkBounds, samplePointer, strokePath } from './ink.js';

describe('ink sampling and payload', () => {
	it('uses coalesced pen events and clamps points', () => {
		const event = { getCoalescedEvents: () => [{ clientX: -1, clientY: 2 }, { clientX: 0.5, clientY: 0.3 }] } as PointerEvent;
		expect(samplePointer(event, (x, y) => ({ x, y }))).toEqual([0, 1, 0.5, 0.3]);
		expect(samplePointer({ clientX: 0.2, clientY: 0.4 } as PointerEvent, (x, y) => ({ x, y }))).toEqual([0.2, 0.4]);
	});
	it('simplifies and quantizes a dense drawing to both server limits', () => {
		const strokes = Array.from({ length: 200 }, (_, s) => Array.from({ length: 1200 }, (_, i) =>
			[i / 1200, (Math.sin(i + s) + 1) / 2]).flat());
		const data = finishInk(strokes, '#111827', 0.004);
		expect(data.strokes.reduce((sum, stroke) => sum + stroke.length / 2, 0)).toBeLessThanOrEqual(PAGE_ANNOTATION_LIMITS.points);
		expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(PAGE_ANNOTATION_LIMITS.dataBytes);
		expect(validatePageAnnotationInput({ kind: 'ink', locator: { type: 'pdf', page: 1, rect: inkBounds(data.strokes) }, position: 0, data })).toBe(true);
		expect(data.strokes.flat().every((value) => Math.abs(value * 10000 - Math.round(value * 10000)) < 1e-8)).toBe(true);
		const moved = finishInk(data.strokes.map((stroke) => stroke.map((value) => Math.min(1, value + 0.0123456789))), data.color, data.width);
		expect(validatePageAnnotationInput({ kind: 'ink', locator: { type: 'pdf', page: 1, rect: inkBounds(moved.strokes) }, position: 0, data: moved })).toBe(true);
	});
	it('accepts a single dot at the page edge and rejects excessive strokes', () => {
		const data = finishInk([[1, 1]], '#111827', 0.002);
		expect(validatePageAnnotationInput({ kind: 'ink', locator: { type: 'pdf', page: 1, rect: inkBounds(data.strokes) }, position: 0, data })).toBe(true);
		expect(() => finishInk(Array.from({ length: 201 }, () => [0, 0]), '#111827', 0.004)).toThrow('200');
		expect(() => finishInk([], '#111827', 0.004)).toThrow();
		expect(strokePath([0, 0, 0.5, 1])).toBe('M0 0 L0.5 1');
	});
});
