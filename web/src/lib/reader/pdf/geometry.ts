import type { NormalizedPoint, NormalizedRect, PdfRotation } from './types.js';

function normalize(rotation: number): PdfRotation {
	return (((rotation % 360) + 360) % 360) as PdfRotation;
}

/** Unrotated → displayed (rotated clockwise by `rotation`) normalized point. */
export function pointToRotated(point: NormalizedPoint, rotation: number): NormalizedPoint {
	switch (normalize(rotation)) {
		case 90: return { x: 1 - point.y, y: point.x };
		case 180: return { x: 1 - point.x, y: 1 - point.y };
		case 270: return { x: point.y, y: 1 - point.x };
		default: return { ...point };
	}
}

export function pointFromRotated(point: NormalizedPoint, rotation: number): NormalizedPoint {
	return pointToRotated(point, 360 - normalize(rotation));
}

export function clampRect(rect: NormalizedRect): NormalizedRect {
	const x = Math.min(1, Math.max(0, rect.x));
	const y = Math.min(1, Math.max(0, rect.y));
	return { x, y, width: Math.max(0, Math.min(1 - x, rect.width)), height: Math.max(0, Math.min(1 - y, rect.height)) };
}

/** Unrotated → displayed normalized rect. */
export function toRotated(rect: NormalizedRect, rotation: number): NormalizedRect {
	const a = pointToRotated({ x: rect.x, y: rect.y }, rotation);
	const b = pointToRotated({ x: rect.x + rect.width, y: rect.y + rect.height }, rotation);
	return clampRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });
}

export function fromRotated(rect: NormalizedRect, rotation: number): NormalizedRect {
	return toRotated(rect, 360 - normalize(rotation));
}

/** Merges rects that sit on the same text line and touch or overlap horizontally. */
export function mergeLineRects(rects: NormalizedRect[], tolerance = 0.002): NormalizedRect[] {
	const sorted = [...rects].filter((rect) => rect.width > 0 && rect.height > 0)
		.sort((a, b) => a.y - b.y || a.x - b.x);
	const merged: NormalizedRect[] = [];
	for (const rect of sorted) {
		const line = merged.find((other) => {
			const overlap = Math.min(other.y + other.height, rect.y + rect.height) - Math.max(other.y, rect.y);
			return overlap > 0.5 * Math.min(other.height, rect.height) &&
				rect.x <= other.x + other.width + tolerance && other.x <= rect.x + rect.width + tolerance;
		});
		if (!line) {
			merged.push({ ...rect });
			continue;
		}
		const right = Math.max(line.x + line.width, rect.x + rect.width);
		const bottom = Math.max(line.y + line.height, rect.y + rect.height);
		line.x = Math.min(line.x, rect.x);
		line.y = Math.min(line.y, rect.y);
		line.width = right - line.x;
		line.height = bottom - line.y;
	}
	return merged;
}
