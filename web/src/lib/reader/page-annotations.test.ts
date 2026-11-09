import { describe, expect, it } from 'vitest';
import {
	deletePageAnnotation, isPageAnnotation, makePageAnnotation, PAGE_ANNOTATION_LIMITS,
	quantize, simplifyStroke, validatePageAnnotationInput
} from './page-annotations.js';
import type { PageAnnotation, PageAnnotationInput } from './types.js';

const locator = { type: 'pdf' as const, page: 1, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
const input: PageAnnotationInput = {
	kind: 'text', locator, position: 0.5,
	data: { text: 'Hello', color: '#123abc', size: 0.02 }
};
const row: PageAnnotation = {
	...input, id: '018f0f7e-7b00-7000-8000-000000000001', book_id: 7, book_file_id: 3,
	created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T00:00:00Z', deleted_at: null, rev: 1
};

function inkAtBytes(size: number): PageAnnotationInput {
	const points = Array<number>(20_000).fill(0);
	const ink: PageAnnotationInput = {
		kind: 'ink', locator, position: 0,
		data: { color: '#abcdef', width: 0.001, strokes: [points] }
	};
	const difference = size - new TextEncoder().encode(JSON.stringify(ink.data)).length;
	const full = Math.floor(difference / 5);
	const remainder = difference % 5;
	points.fill(0.1234, 0, full);
	if (remainder === 1) points[full - 1] = 0.12345;
	else if (remainder > 1) points[full] = Number(`0.${'1'.repeat(remainder - 1)}`);
	return ink;
}

describe('page annotation data', () => {
	it('builds UUIDv7 upserts and deletes, preserving the existing identity and kind', () => {
		const mutation = makePageAnnotation(7, 3, input);
		expect(mutation).toMatchObject({
			entity: 'page_annotations', op: 'upsert',
			data: { book_id: 7, book_file_id: 3, ...input }
		});
		expect('id' in mutation && mutation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(makePageAnnotation(7, null, input, row)).toMatchObject({ id: row.id, data: { book_file_id: null } });
		expect(deletePageAnnotation(row.id)).toMatchObject({ entity: 'page_annotations', id: row.id, op: 'delete', data: {} });
		expect(() => makePageAnnotation(8, 3, input, row)).toThrow('book or kind');
		expect(() => makePageAnnotation(7, 3, {
			kind: 'ink', locator, position: 0.5, data: { color: '#000000', width: 0.001, strokes: [[0, 0]] }
		}, row)).toThrow('book or kind');
		expect(() => makePageAnnotation(7, -1, input)).toThrow('invalid');
	});

	it('validates text, normalized locators and their exact boundaries', () => {
		expect(validatePageAnnotationInput(input)).toBe(true);
		for (const text of ['a', '😀'.repeat(4000)]) {
			expect(validatePageAnnotationInput({ ...input, data: { ...input.data, text, size: 0.008 } })).toBe(true);
		}
		for (const text of ['', 'a\0b', '😀'.repeat(4001)]) {
			expect(validatePageAnnotationInput({ ...input, data: { ...input.data, text } })).toBe(false);
		}
		for (const size of [0.008, 0.08]) {
			expect(validatePageAnnotationInput({ ...input, data: { ...input.data, size } })).toBe(true);
		}
		for (const size of [0.007999, 0.080001, Number.NaN]) {
			expect(validatePageAnnotationInput({ ...input, data: { ...input.data, size } })).toBe(false);
		}
		expect(validatePageAnnotationInput({ ...input, data: { ...input.data, color: '#ABCDEF' } })).toBe(false);
		expect(validatePageAnnotationInput({ ...input, data: { ...input.data, extra: true } })).toBe(false);
		for (const badLocator of [
			{ ...locator, page: 0 },
			{ ...locator, page: 1.5 },
			{ ...locator, rect: { ...locator.rect, x: 0.9 } },
			{ ...locator, rect: { ...locator.rect, width: 0 } },
			{ ...locator, rect: { ...locator.rect, x: null } }
		]) {
			expect(validatePageAnnotationInput({ ...input, locator: badLocator })).toBe(false);
		}
		expect(validatePageAnnotationInput({ ...input, position: 1 })).toBe(true);
		expect(validatePageAnnotationInput({ ...input, position: 1.01 })).toBe(false);
	});

	it('validates ink counts, coordinates, widths and the exact 64 KiB data limit', () => {
		const ink = (strokes: number[][], width = 0.001) => ({
			kind: 'ink', locator, position: 0, data: { color: '#abcdef', width, strokes }
		});
		expect(validatePageAnnotationInput(ink([[0, 0]], 0.02))).toBe(true);
		expect(validatePageAnnotationInput(ink(Array.from({ length: 200 }, () => [0, 0])))).toBe(true);
		expect(validatePageAnnotationInput(ink(Array.from({ length: 201 }, () => [0, 0])))).toBe(false);
		expect(validatePageAnnotationInput(ink([Array(20_000).fill(0)]))).toBe(true);
		expect(validatePageAnnotationInput(ink([Array(20_002).fill(0)]))).toBe(false);
		for (const strokes of [[], [[0]], [[0, 0, 1]], [[0, -0.01]], [[0, Infinity]], [[0, null]]]) {
			expect(validatePageAnnotationInput({ kind: 'ink', locator, position: 0, data: { color: '#abcdef', width: 0.01, strokes } })).toBe(false);
		}
		expect(validatePageAnnotationInput(ink([[0, 0]], 0.0009))).toBe(false);
		expect(validatePageAnnotationInput(ink([[0, 0]], 0.0201))).toBe(false);
		const maximum = inkAtBytes(PAGE_ANNOTATION_LIMITS.dataBytes);
		const oversized = inkAtBytes(PAGE_ANNOTATION_LIMITS.dataBytes + 1);
		expect(new TextEncoder().encode(JSON.stringify(maximum.data))).toHaveLength(65536);
		expect(new TextEncoder().encode(JSON.stringify(oversized.data))).toHaveLength(65537);
		expect(validatePageAnnotationInput(maximum)).toBe(true);
		expect(validatePageAnnotationInput(oversized)).toBe(false);
	});

	it('validates image references and full sync rows', () => {
		const image = {
			kind: 'image', locator, position: 1,
			data: { asset: 'a'.repeat(64), media_type: 'image/webp', width: 1, height: 8192 }
		};
		expect(validatePageAnnotationInput(image)).toBe(true);
		for (const data of [
			{ ...image.data, asset: 'A'.repeat(64) },
			{ ...image.data, media_type: 'image/gif' },
			{ ...image.data, width: 0 },
			{ ...image.data, height: 8193 },
			{ ...image.data, width: 1.5 }
		]) {
			expect(validatePageAnnotationInput({ ...image, data })).toBe(false);
		}
		expect(isPageAnnotation(row)).toBe(true);
		expect(isPageAnnotation({ ...row, book_file_id: null, deleted_at: row.updated_at })).toBe(true);
		expect(isPageAnnotation({ ...row, id: 'not-a-uuid' })).toBe(false);
		expect(isPageAnnotation({ ...row, rev: -1 })).toBe(false);
		expect(isPageAnnotation({ ...row, data: { ...input.data, text: '' } })).toBe(false);
	});

	it('simplifies strokes without changing endpoints and quantizes to four decimals', () => {
		expect(simplifyStroke([0, 0, 0.25, 0.25, 0.5, 0.5, 1, 1])).toEqual([0, 0, 1, 1]);
		expect(simplifyStroke([0, 0, 0.5, 1, 1, 0])).toEqual([0, 0, 0.5, 1, 1, 0]);
		expect(simplifyStroke([0.2, 0.2])).toEqual([0.2, 0.2]);
		expect(quantize([0.123456, 0.654321])).toEqual([0.1235, 0.6543]);
		expect(quantize([0.123, 0.987], 2)).toEqual([0.12, 0.99]);
		expect(() => simplifyStroke([0, 0, 1])).toThrow('x/y pairs');
		expect(() => simplifyStroke([0, 0], -1)).toThrow('tolerance');
		expect(() => quantize([Number.NaN, 0])).toThrow('x/y pairs');
	});
});
