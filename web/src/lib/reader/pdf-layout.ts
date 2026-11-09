import type { NormalizedRect } from './types.js';

export function pdfPageAtFraction(value: number, pages: number): number {
	return Math.round(Math.min(1, Math.max(0, value)) * (pages - 1)) + 1;
}

export function pdfPageFraction(page: number, pages: number): number {
	return pages === 1 ? 0 : (page - 1) / (pages - 1);
}

export function rotatePdfRect(rect: NormalizedRect, rotation: number): NormalizedRect {
	switch ((rotation % 360 + 360) % 360) {
		case 90: return { x: Math.max(0, 1 - rect.y - rect.height), y: rect.x, width: rect.height, height: rect.width };
		case 180: return { ...rect, x: Math.max(0, 1 - rect.x - rect.width), y: Math.max(0, 1 - rect.y - rect.height) };
		case 270: return { x: rect.y, y: Math.max(0, 1 - rect.x - rect.width), width: rect.height, height: rect.width };
		default: return { ...rect };
	}
}
