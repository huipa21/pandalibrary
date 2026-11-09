import { placeAbove, type RectLike } from './floating.js';

export interface FloatAtParams {
	anchor: RectLike;
	bounds: RectLike;
}

/** Keeps a `position: fixed` element placed above (or below) `anchor`, inside `bounds`. */
export function floatAt(node: HTMLElement, params: FloatAtParams) {
	let current = params;
	function place() {
		const { left, top, placement } = placeAbove(current.anchor, { width: node.offsetWidth, height: node.offsetHeight }, current.bounds);
		node.style.left = `${Math.round(left)}px`;
		node.style.top = `${Math.round(top)}px`;
		node.dataset.placement = placement;
	}
	place();
	const observer = new ResizeObserver(place);
	observer.observe(node);
	return {
		update(next: FloatAtParams) {
			current = next;
			place();
		},
		destroy() {
			observer.disconnect();
		}
	};
}
