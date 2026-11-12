import { v7 as uuidv7 } from 'uuid';
import type { Mutation } from './api.js';
import type { PageAnnotation, PageAnnotationInput, PageAnnotationLocator } from './types.js';

export const PAGE_ANNOTATION_LIMITS = {
	locatorBytes: 16 * 1024,
	dataBytes: 64 * 1024,
	textCodePoints: 4000,
	textSizeMin: 0.008,
	textSizeMax: 0.08,
	inkWidthMin: 0.001,
	inkWidthMax: 0.02,
	strokes: 200,
	points: 10000,
	imageDimension: 8192
} as const;

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const color = /^#[0-9a-f]{6}$/;
const assetHash = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function inRange(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function isPageLocator(value: unknown): value is PageAnnotationLocator {
	if (!isRecord(value) || !(
		value.type === 'pdf' && hasOnlyKeys(value, ['type', 'page', 'rect']) && positiveInteger(value.page) ||
		value.type === 'cfi' && hasOnlyKeys(value, ['type', 'value', 'rect']) &&
			typeof value.value === 'string' && value.value.startsWith('epubcfi(') &&
			value.value.endsWith(')') && !value.value.includes('\0')
	) || !isRecord(value.rect) ||
		!hasOnlyKeys(value.rect, ['x', 'y', 'width', 'height'])) return false;
	const { x, y, width, height } = value.rect;
	return inRange(x, 0, 1) && inRange(y, 0, 1) &&
		inRange(width, 0, 1) && width > 0 && x + width <= 1 &&
		inRange(height, 0, 1) && height > 0 && y + height <= 1 &&
		encoder.encode(JSON.stringify(value)).length <= PAGE_ANNOTATION_LIMITS.locatorBytes;
}

export function validatePageAnnotationInput(value: unknown): value is PageAnnotationInput {
	if (!isRecord(value) || !isPageLocator(value.locator) || !inRange(value.position, 0, 1) ||
		!isRecord(value.data)) return false;
	const data = value.data;
	switch (value.kind) {
		case 'text':
			if (!hasOnlyKeys(data, ['text', 'color', 'size']) || typeof data.text !== 'string' ||
				data.text.includes('\0') || [...data.text].length < 1 ||
				[...data.text].length > PAGE_ANNOTATION_LIMITS.textCodePoints ||
				typeof data.color !== 'string' || !color.test(data.color) ||
				!inRange(data.size, PAGE_ANNOTATION_LIMITS.textSizeMin, PAGE_ANNOTATION_LIMITS.textSizeMax)) {
				return false;
			}
			break;
		case 'ink': {
			if (!hasOnlyKeys(data, ['color', 'width', 'strokes']) ||
				typeof data.color !== 'string' || !color.test(data.color) ||
				!inRange(data.width, PAGE_ANNOTATION_LIMITS.inkWidthMin, PAGE_ANNOTATION_LIMITS.inkWidthMax) ||
				!Array.isArray(data.strokes) || data.strokes.length < 1 ||
				data.strokes.length > PAGE_ANNOTATION_LIMITS.strokes) return false;
			let points = 0;
			for (const stroke of data.strokes) {
				if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length % 2 !== 0) return false;
				points += stroke.length / 2;
				if (points > PAGE_ANNOTATION_LIMITS.points) return false;
				for (const coordinate of stroke) {
					if (!inRange(coordinate, 0, 1)) return false;
				}
			}
			break;
		}
		case 'image':
			if (!hasOnlyKeys(data, ['asset', 'media_type', 'width', 'height']) ||
				typeof data.asset !== 'string' || !assetHash.test(data.asset) ||
				(data.media_type !== 'image/png' && data.media_type !== 'image/jpeg' && data.media_type !== 'image/webp') ||
				!positiveInteger(data.width, PAGE_ANNOTATION_LIMITS.imageDimension) ||
				!positiveInteger(data.height, PAGE_ANNOTATION_LIMITS.imageDimension)) return false;
			break;
		default:
			return false;
	}
	return encoder.encode(JSON.stringify(data)).length <= PAGE_ANNOTATION_LIMITS.dataBytes;
}

export function isPageAnnotation(value: unknown): value is PageAnnotation {
	if (!isRecord(value) || typeof value.id !== 'string' || !uuidV7.test(value.id) ||
		!positiveInteger(value.book_id) ||
		(value.book_file_id !== null && !positiveInteger(value.book_file_id)) ||
		typeof value.created_at !== 'string' || typeof value.updated_at !== 'string' ||
		(value.deleted_at !== null && typeof value.deleted_at !== 'string') ||
		typeof value.rev !== 'number' || !Number.isSafeInteger(value.rev) || value.rev < 0) return false;
	return validatePageAnnotationInput({
		kind: value.kind, locator: value.locator, position: value.position, data: value.data
	});
}

export function makePageAnnotation(
	bookId: number,
	fileId: number | null,
	input: PageAnnotationInput,
	existing?: PageAnnotation
): Mutation {
	if (!positiveInteger(bookId) || (fileId !== null && !positiveInteger(fileId)) ||
		!validatePageAnnotationInput(input)) {
		throw new Error('Page annotation is invalid or exceeds the server limits.');
	}
	if (existing && (existing.book_id !== bookId || existing.kind !== input.kind)) {
		throw new Error('A page annotation cannot change its book or kind.');
	}
	return {
		entity: 'page_annotations',
		id: existing?.id ?? uuidv7(),
		op: 'upsert',
		updated_at: Date.now(),
		data: {
			book_id: bookId, book_file_id: fileId, kind: input.kind,
			locator: input.locator, position: input.position, data: input.data
		}
	};
}

export function deletePageAnnotation(id: string): Mutation {
	return { entity: 'page_annotations', id, op: 'delete', data: {}, updated_at: Date.now() };
}

function validatePoints(points: readonly number[]): void {
	if (points.length < 2 || points.length % 2 !== 0) {
		throw new Error('Stroke points must be finite x/y pairs.');
	}
	for (const point of points) {
		if (!Number.isFinite(point)) throw new Error('Stroke points must be finite x/y pairs.');
	}
}

export function quantize(points: readonly number[], decimals = 4): number[] {
	validatePoints(points);
	if (!Number.isInteger(decimals) || decimals < 0 || decimals > 10) {
		throw new Error('Quantization precision is invalid.');
	}
	const factor = 10 ** decimals;
	return points.map((point) => Math.round(point * factor) / factor);
}

export function simplifyStroke(points: readonly number[], epsilon = 0.0015): number[] {
	validatePoints(points);
	if (!Number.isFinite(epsilon) || epsilon < 0) throw new Error('Stroke tolerance is invalid.');
	const count = points.length / 2;
	if (count <= 2) return [...points];
	const keep = new Uint8Array(count);
	keep[0] = 1;
	keep[count - 1] = 1;
	const ranges: [number, number][] = [[0, count - 1]];
	const threshold = epsilon * epsilon;
	while (ranges.length > 0) {
		const range = ranges.pop();
		if (!range) break;
		const [first, last] = range;
		const x = points[first * 2];
		const y = points[first * 2 + 1];
		const dx = points[last * 2] - x;
		const dy = points[last * 2 + 1] - y;
		const length = dx * dx + dy * dy;
		let farthest = -1;
		let distance = threshold;
		for (let index = first + 1; index < last; index++) {
			const px = points[index * 2] - x;
			const py = points[index * 2 + 1] - y;
			const projection = length === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / length));
			const ex = px - projection * dx;
			const ey = py - projection * dy;
			const candidate = ex * ex + ey * ey;
			if (candidate > distance) {
				distance = candidate;
				farthest = index;
			}
		}
		if (farthest !== -1) {
			keep[farthest] = 1;
			ranges.push([first, farthest], [farthest, last]);
		}
	}
	const simplified: number[] = [];
	for (let index = 0; index < count; index++) {
		if (keep[index]) simplified.push(points[index * 2], points[index * 2 + 1]);
	}
	return simplified;
}
