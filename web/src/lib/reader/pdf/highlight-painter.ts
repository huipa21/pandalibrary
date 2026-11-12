import { isPdfLocator, type ReaderAnnotation } from '../types.js';
import { isHighlightStyle } from '../annotations.js';
import { observeMarkTone, paintMarkColor } from './marks/mark-paint.js';
import type { PageLayerPainter } from './types.js';

/** Paints `addAnnotation` highlights (marks) until PV8 replaces the painter by name. */
export function highlightPainter(annotations: () => Iterable<ReaderAnnotation>, viewport?: () => HTMLElement): PageLayerPainter {
	const toneObserver = observeMarkTone(viewport);
	return {
		name: 'highlight',
		z: 3,
		paint({ page, layer, toCss }) {
			const tone = toneObserver.watch(layer);
			for (const annotation of annotations()) {
				const locator = annotation.locator;
				if (!isPdfLocator(locator) || locator.page !== page) continue;
				for (const rect of locator.rects ?? []) {
					const mark = document.createElement('span');
					mark.className = 'reader-pdf-highlight';
					mark.dataset.annotationId = annotation.id;
					const style = isHighlightStyle(annotation.style) ? annotation.style : 'highlight';
					mark.dataset.style = style;
					Object.assign(mark.style, toCss(rect));
					paintMarkColor(mark, annotation.color, style, tone);
					layer.append(mark);
				}
			}
		},
		dispose: toneObserver.dispose
	};
}
