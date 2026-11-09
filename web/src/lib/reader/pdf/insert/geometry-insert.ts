import type { NormalizedPoint, NormalizedRect } from '../types.js';

export const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function pointRect(point: NormalizedPoint, width: number, height: number): NormalizedRect {
	width = clamp(width, 0.0001);
	height = clamp(height, 0.0001);
	return { x: clamp(point.x, 0, 1 - width), y: clamp(point.y, 0, 1 - height), width, height };
}

export function imageRect(point: NormalizedPoint, aspect: number, pageWidth: number, pageHeight: number): NormalizedRect {
	const width = Math.min(0.3, aspect * pageHeight / pageWidth);
	return pointRect(point, width, width * pageWidth / (aspect * pageHeight));
}

export function resizeImage(rect: NormalizedRect, point: NormalizedPoint, corner: string, width: number, height: number): NormalizedRect {
	const left = corner.includes('w'), top = corner.includes('n');
	const anchor = { x: left ? rect.x + rect.width : rect.x, y: top ? rect.y + rect.height : rect.y };
	const ratio = rect.height / rect.width;
	const maximum = Math.min(left ? anchor.x : 1 - anchor.x, (top ? anchor.y : 1 - anchor.y) / ratio);
	const minimum = Math.min(maximum, Math.max(24 / width, 24 / height / ratio));
	const size = clamp(Math.max(left ? anchor.x - point.x : point.x - anchor.x,
		(top ? anchor.y - point.y : point.y - anchor.y) / ratio), minimum, maximum);
	return pointRect({ x: left ? anchor.x - size : anchor.x, y: top ? anchor.y - size * ratio : anchor.y }, size, size * ratio);
}
