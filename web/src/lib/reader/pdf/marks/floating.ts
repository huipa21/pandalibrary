export interface RectLike {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface FloatingPlacement {
	left: number;
	top: number;
	placement: 'above' | 'below';
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Places a floating element `gap` px above `anchor`, centred on it, flipping below when there is no room
 * above, and clamped inside `viewport` (all in client coordinates).
 */
export function placeAbove(
	anchor: RectLike,
	size: { width: number; height: number },
	viewport: RectLike,
	gap = 8
): FloatingPlacement {
	const centre = (anchor.left + anchor.right) / 2;
	const minLeft = viewport.left + gap;
	const left = clamp(centre - size.width / 2, minLeft, Math.max(minLeft, viewport.right - gap - size.width));
	const minTop = viewport.top + gap;
	const maxTop = Math.max(minTop, viewport.bottom - gap - size.height);
	const above = anchor.top - gap - size.height;
	if (above >= minTop) return { left, top: Math.min(above, maxTop), placement: 'above' };
	return { left, top: clamp(anchor.bottom + gap, minTop, maxTop), placement: 'below' };
}

export function intersects(a: RectLike, b: RectLike): boolean {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

export function unionRect(rects: Iterable<RectLike>): RectLike | null {
	let union: RectLike | null = null;
	for (const rect of rects) {
		union = union
			? {
				left: Math.min(union.left, rect.left), top: Math.min(union.top, rect.top),
				right: Math.max(union.right, rect.right), bottom: Math.max(union.bottom, rect.bottom)
			}
			: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
	}
	return union;
}
