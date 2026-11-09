import type { PdfViewerEngine } from './engine.js';
import type { PdfTool } from './types.js';
import { clampScale, wheelFactor } from './zoom.js';

export { wheelFactor };

export function atEdge(top: number, height: number, scrollHeight: number, direction: -1 | 1): boolean {
	return direction === -1 ? top <= 1 : top + height >= scrollHeight - 1;
}

interface GestureOptions {
	tool: () => PdfTool;
	turn: (direction: -1 | 1) => Promise<void>;
	error: (error: unknown) => void;
}

/** Ctrl/⌘+wheel and pinch zoom anchored under the pointer, hand-tool panning and edge paging. */
export function attachPdfGestures(engine: PdfViewerEngine, options: GestureOptions): () => void {
	const surface = engine.viewport;
	const listeners = new AbortController();
	const touches = new Map<number, { x: number; y: number }>();
	let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
	let swipe: { y: number; top: number } | null = null;
	let distance = 0;
	let lockUntil = 0;
	let frame = 0;
	let pending: { scale: number; clientX: number; clientY: number } | null = null;

	function applyZoom() {
		frame = 0;
		if (!pending) return;
		const { scale, ...anchor } = pending;
		pending = null;
		try {
			engine.setZoom(scale, anchor);
		} catch (error) {
			options.error(error);
		}
	}

	// Several wheel/pinch events per frame compound into one re-render.
	function zoom(factor: number, clientX: number, clientY: number) {
		pending = { scale: clampScale((pending?.scale ?? engine.state.scale) * factor), clientX, clientY };
		if (!frame) frame = requestAnimationFrame(applyZoom);
	}

	function edge(direction: -1 | 1, top = surface.scrollTop): boolean {
		if (engine.state.layout.endsWith('continuous') || !atEdge(top, surface.clientHeight, surface.scrollHeight, direction)) return false;
		if (performance.now() >= lockUntil) {
			lockUntil = performance.now() + 300;
			void options.turn(direction).catch(options.error);
		}
		return true;
	}

	surface.addEventListener('wheel', (event) => {
		if ((event.ctrlKey || event.metaKey) && event.deltaY) {
			event.preventDefault();
			zoom(wheelFactor(event.deltaY, event.deltaMode), event.clientX, event.clientY);
		} else if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && event.deltaY && edge(event.deltaY > 0 ? 1 : -1)) {
			event.preventDefault();
		}
	}, { signal: listeners.signal, passive: false });

	surface.addEventListener('pointerdown', (event) => {
		if (event.pointerType === 'touch') {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (touches.size === 1) swipe = { y: event.clientY, top: surface.scrollTop };
			if (touches.size === 2) {
				const [a, b] = [...touches.values()];
				distance = Math.hypot(a.x - b.x, a.y - b.y);
				swipe = null;
			}
			return;
		}
		if (event.defaultPrevented || event.pointerType !== 'mouse' || event.button !== 0 || options.tool() !== 'hand' ||
			(event.target instanceof Element && event.target.closest('button, a, input, textarea, select, [contenteditable="true"]'))) return;
		drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: surface.scrollLeft, top: surface.scrollTop };
		surface.setPointerCapture(event.pointerId);
		surface.classList.add('pv-panning');
		event.preventDefault();
	}, { signal: listeners.signal });

	surface.addEventListener('pointermove', (event) => {
		if (touches.has(event.pointerId)) {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (touches.size === 2) {
				const [a, b] = [...touches.values()];
				const next = Math.hypot(a.x - b.x, a.y - b.y);
				if (distance > 0) zoom(next / distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
				distance = next;
			}
		} else if (drag?.id === event.pointerId) {
			surface.scrollLeft = drag.left - event.clientX + drag.x;
			surface.scrollTop = drag.top - event.clientY + drag.y;
		}
	}, { signal: listeners.signal });

	function end(event: PointerEvent) {
		if (event.type === 'pointerup' && touches.size === 1 && swipe && Math.abs(event.clientY - swipe.y) > 40) {
			edge(event.clientY < swipe.y ? 1 : -1, swipe.top);
		}
		touches.delete(event.pointerId);
		if (touches.size < 2) distance = 0;
		swipe = null;
		if (drag?.id === event.pointerId) {
			drag = null;
			surface.classList.remove('pv-panning');
		}
	}
	for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
		surface.addEventListener(name, end, { signal: listeners.signal });
	}
	// A single touch retains native scrolling; only a two-finger gesture is claimed.
	for (const name of ['touchstart', 'touchmove'] as const) {
		surface.addEventListener(name, (event) => {
			if (event.touches.length === 2) event.preventDefault();
		}, { signal: listeners.signal, passive: false });
	}
	return () => {
		listeners.abort();
		cancelAnimationFrame(frame);
		surface.classList.remove('pv-panning');
	};
}
