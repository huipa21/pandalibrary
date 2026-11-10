export const ANNOTATION_ROW_HEIGHT = 56;
export const VIRTUAL_THRESHOLD = 300;
const OVERSCAN = 6;
const MAX_RENDERED = 40;

export function annotationWindow(count: number, scrollTop: number, viewportHeight: number, force = false) {
	if (!force && count <= VIRTUAL_THRESHOLD) return { start: 0, end: count };
	const first = Math.max(0, Math.floor(scrollTop / ANNOTATION_ROW_HEIGHT));
	const visible = Math.max(1, Math.ceil(viewportHeight / ANNOTATION_ROW_HEIGHT));
	const length = Math.min(MAX_RENDERED, visible + 2 * OVERSCAN, count);
	const start = Math.min(Math.max(0, first - OVERSCAN), count - length);
	return { start, end: start + length };
}
